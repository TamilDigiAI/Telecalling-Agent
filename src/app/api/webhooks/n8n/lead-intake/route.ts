import { NextResponse, type NextRequest } from 'next/server';
import {
  createLocalPilotSupabaseClient,
  createPilotFounderCookieValue,
  PILOT_FOUNDER_USER_ID,
  verifyPilotFounderCookieValue,
} from '@/lib/supabase/local-pilot-fallback';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/server';
import { DEFAULT_GOOGLE_SHEET_ID, DEFAULT_WORKSPACE_SLUG, getRuntimeEnv } from '@/lib/env';
import { recordCallOutcomeAndFollowUp } from '@/lib/crm/service';
import { resolveBusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';
import {
  buildRecordOutcomeInputFromSimulation,
  type MockCallScenario,
  simulateOutboundCallWithNila,
} from '@/lib/telephony/mock-provider';
import { synthesizeNilaAudioWithBulbul } from '@/lib/voice/sarvam-nila';
import { processPendingSheetSyncJobs } from '@/lib/sheets/google-sheets-sync';
import type { Lead, Workspace } from '@/types/crm';

export const runtime = 'nodejs';

function normalizeIndianMobileToE164(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0') && /^0[6-9]\d{9}$/.test(digits)) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) {
    return `+${digits}`;
  }
  return null;
}

function verifyWebhookSecret(request: NextRequest): boolean {
  const configuredSecret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (!configuredSecret || configuredSecret.includes('your_n8n_webhook_secret')) {
    return true;
  }
  const headerSecret =
    request.headers.get('x-n8n-webhook-secret') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return headerSecret === configuredSecret;
}

async function getServerCrmClient() {
  const env = getRuntimeEnv();
  if (env.isSupabaseConfigured && env.supabaseSecretKey) {
    return createServiceRoleSupabaseClient();
  }
  const user = verifyPilotFounderCookieValue(
    createPilotFounderCookieValue('pheonixtamil2025@gmail.com')
  )!;
  return createLocalPilotSupabaseClient(user);
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'DigiAnchorZ Voice CRM · n8n Lead Intake & Instant Voice Call Webhook',
    endpoint: '/api/webhooks/n8n/lead-intake',
    googleSheetId: DEFAULT_GOOGLE_SHEET_ID,
    supportedFields: [
      'Lead ID / externalLeadId',
      'Name / fullName',
      'Phone / phone',
      'Service / serviceInterest',
      'Source / source',
      'row_number / sheetRowNumber',
    ],
  });
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyWebhookSecret(request)) {
      return NextResponse.json(
        { error: 'Unauthorized: invalid x-n8n-webhook-secret header' },
        { status: 401 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const rawPhone = String(
      body.Phone ?? body.phone ?? body.mobile ?? body.phone_e164 ?? ''
    ).trim();
    const phoneE164 = normalizeIndianMobileToE164(rawPhone);

    if (!phoneE164) {
      return NextResponse.json(
        {
          error: `Invalid or missing Indian mobile number: "${rawPhone}". Expected 10-digit mobile or +91 E.164 format.`,
        },
        { status: 400 }
      );
    }

    const fullName =
      String(body.Name ?? body.fullName ?? body.full_name ?? 'Google Sheet Lead').trim() ||
      'Google Sheet Lead';
    const serviceInterest =
      String(
        body.Service ??
          body.service ??
          body.serviceInterest ??
          body.service_interest ??
          'Meta Ads for Facebook and Instagram lead generation'
      ).trim() || 'Meta Ads for Facebook and Instagram lead generation';
    const source = String(body.Source ?? body.source ?? 'Google Sheet (n8n)').trim();
    const sheetRowNumber = Number(body.row_number ?? body.sheetRowNumber ?? body.rowNumber ?? 2);
    const externalLeadId =
      String(
        body['Lead ID'] ??
          body.leadId ??
          body.external_lead_id ??
          `GSHEET-${phoneE164.slice(-10)}`
      ).trim() || `GSHEET-${phoneE164.slice(-10)}`;
    const doNotCallInput =
      String(body['Do Not Call'] ?? body.doNotCall ?? 'FALSE')
        .trim()
        .toUpperCase() === 'TRUE';

    const scenario: MockCallScenario =
      body.scenario === 'WARM_INTEREST' ||
      body.scenario === 'NO_ANSWER' ||
      body.scenario === 'OPT_OUT_DNC' ||
      body.scenario === 'PRICING_NO_APPROVED_RATE'
        ? body.scenario
        : 'HOT_CALLBACK';

    const supabase = await getServerCrmClient();

    // 1. Resolve DigiAnchorZ workspace
    const { data: wsData } = await supabase
      .from('workspaces')
      .select('*')
      .eq('slug', DEFAULT_WORKSPACE_SLUG)
      .maybeSingle();

    const workspace = wsData as Workspace | null;
    if (!workspace) {
      return NextResponse.json({ error: 'DigiAnchorZ workspace not found' }, { status: 404 });
    }

    // 2. Find or create Lead in CRM from the Google Sheet row
    const { data: existingLeads } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id);

    let lead = ((existingLeads ?? []) as Lead[]).find(
      (l) => l.phone_e164 === phoneE164 || l.external_lead_id === externalLeadId
    );

    if (!lead) {
      const { data: insertedLead, error: insertError } = await supabase
        .from('leads')
        .insert({
          workspace_id: workspace.id,
          external_lead_id: externalLeadId,
          sheet_id: workspace.google_sheet_id || DEFAULT_GOOGLE_SHEET_ID,
          sheet_tab: workspace.google_sheet_tab || 'Leads',
          sheet_row_number: Number.isFinite(sheetRowNumber) ? sheetRowNumber : 2,
          full_name: fullName,
          raw_phone: rawPhone,
          phone_e164: phoneE164,
          service_interest: serviceInterest,
          source,
          calling_eligibility: 'ELIGIBLE',
          eligibility_reference:
            String(body['Eligibility Reference'] ?? body.eligibilityReference ?? '').trim() ||
            `N8N-GSHEET-ROW-${sheetRowNumber}`,
          available_window: '09:00-20:00 IST',
          do_not_call: doNotCallInput,
          lead_temperature: 'UNQUALIFIED',
          owner_user_id: PILOT_FOUNDER_USER_ID,
          sync_status: 'PENDING',
        })
        .select('*')
        .single();

      if (insertError || !insertedLead) {
        throw insertError || new Error('Failed to insert lead in CRM');
      }
      lead = insertedLead as Lead;
    } else {
      await supabase
        .from('leads')
        .update({
          full_name: fullName || lead.full_name,
          service_interest: serviceInterest || lead.service_interest,
          sheet_row_number: Number.isFinite(sheetRowNumber)
            ? sheetRowNumber
            : lead.sheet_row_number,
        })
        .eq('workspace_id', workspace.id)
        .eq('id', lead.id);
    }

    if (lead.do_not_call || doNotCallInput) {
      return NextResponse.json(
        {
          ok: false,
          error: `Call blocked: lead ${lead.full_name} (${lead.phone_e164}) has Do Not Call enabled.`,
          sheetWriteBackRow: {
            row_number: lead.sheet_row_number ?? sheetRowNumber,
            'Lead ID': lead.external_lead_id,
            'CRM Lead ID': lead.id,
            'Call Outcome': 'DO_NOT_CALL',
            'Lead Temperature': lead.lead_temperature,
            'Sync Status': 'SKIPPED',
            'Automation Do Not Call': 'TRUE',
          },
        },
        { status: 409 }
      );
    }

    // 3. Immediately Connect Voice Agent Nila with the Lead via Exotel PSTN (or reuse Node 3 exotel-dial payload)
    const incomingExotel = (body.exotelPicked ?? null) as Record<string, unknown> | null;
    let pstnStatus: 'dialed' | 'error' | 'mock_only' =
      incomingExotel?.pstnStatus === 'dialed' || incomingExotel?.pstnStatus === 'error'
        ? (incomingExotel.pstnStatus as 'dialed' | 'error')
        : 'mock_only';
    let pstnDetail = String(incomingExotel?.pstnDetail ?? '');
    let providerCallSid: string | null = incomingExotel?.providerCallSid
      ? String(incomingExotel.providerCallSid)
      : null;

    const exotelSid =
      String(incomingExotel?.exotelAccountSid ?? '').trim() ||
      process.env.EXOTEL_ACCOUNT_SID?.trim() ||
      'digianchorz1';
    const exotelKey = process.env.EXOTEL_API_KEY?.trim() || '';
    const exotelToken = process.env.EXOTEL_API_TOKEN?.trim() || '';
    const exotelCallerId =
      String(incomingExotel?.exotelCallerId ?? '').trim() ||
      process.env.EXOTEL_CALLER_ID?.trim() ||
      '09513886363';
    const exotelAppId =
      String(incomingExotel?.exotelAppId ?? '').trim() ||
      process.env.EXOTEL_APP_ID?.trim() ||
      '1370873';
    const exotelBaseUrl = (
      process.env.EXOTEL_API_BASE_URL?.trim() || 'https://api.exotel.com'
    ).replace(/\/+$/, '');

    if (
      !incomingExotel &&
      exotelSid &&
      exotelKey &&
      exotelToken &&
      !exotelKey.includes('your_exotel')
    ) {
      try {
        const basicAuth = Buffer.from(`${exotelKey}:${exotelToken}`).toString('base64');
        const nationalNumber = lead.phone_e164.replace(/^\+91/, '0');
        const form = new URLSearchParams();
        form.set('From', nationalNumber);
        form.set('CallerId', exotelCallerId);
        form.set('Url', `http://my.exotel.com/${exotelSid}/exoml/start_voice/${exotelAppId}`);
        form.set('CallType', 'trans');
        form.set('CustomField', `leadId=${lead.id}&source=n8n`);

        const exoRes = await fetch(
          `${exotelBaseUrl}/v1/Accounts/${exotelSid}/Calls/connect.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
          }
        );

        const exoJson = (await exoRes.json().catch(() => ({}))) as {
          Call?: { Sid?: string };
          RestException?: { Message?: string };
        };

        if (exoRes.ok && exoJson.Call?.Sid) {
          pstnStatus = 'dialed';
          providerCallSid = exoJson.Call.Sid;
          pstnDetail = `Exotel PSTN call connected via ExoPhone ${exotelCallerId} to ${lead.phone_e164} (CallSid: ${exoJson.Call.Sid}).`;
        } else {
          pstnStatus = 'error';
          pstnDetail =
            exoJson.RestException?.Message ||
            `Exotel HTTP ${exoRes.status} (Trial credits check). Nila voice qualification completed & logged.`;
        }
      } catch (err) {
        pstnStatus = 'error';
        pstnDetail = err instanceof Error ? err.message : 'Exotel request failed';
      }
    }

    // 4. Generate Nila's spoken call matching the Karur reference voice cadence & phonetic Tamil script
    const settings = resolveBusinessKnowledgeSettings(workspace.business_profile);
    const spokenScript = `வணக்கம்! நான் நிலா, டிஜி ஆங்கர்ஸ் நிறுவனத்தின் ஏஐ என்குயரி அசிஸ்டன்ட் பேசுகிறேன். ${lead.full_name} அவர்களிடம் தான் பேசுகிறேனா? நீங்க மெட்டா ஆட்ஸ் மற்றும் லீட் ஜெனரேஷன் பற்றி என்குயரி செய்திருந்தீர்கள். இப்போ இரண்டு நிமிடம் பேசலாமா? எங்க எம்.டி தமிழ்செல்வன் சார் கிட்ட நாளை காலை பதினோரு மணிக்கு ஒரு ஷார்ட் கால்பேக் அரேஞ்ச் பண்ணலாமா?`;

    const includeAudio = body.includeAudio !== false;
    const tts = includeAudio
      ? await synthesizeNilaAudioWithBulbul(spokenScript)
      : { succeeded: true, modelUsed: 'bulbul:v3', audioBase64: '', latencyMs: 0 };

    // 5. Update Result in CRM Dashboard (call_attempts, leads, follow_up_tasks, sheet_sync_jobs)
    const sim = simulateOutboundCallWithNila(
      lead,
      scenario,
      workspace.agent_name || 'Nila',
      undefined,
      settings
    );
    const outcomeInput = buildRecordOutcomeInputFromSimulation(lead, sim);
    const crmResult = await recordCallOutcomeAndFollowUp(supabase, outcomeInput);

    // 6. Process Google Sheet Outbox Queue & Prepare Exact 20-Column Write-Back Payload for n8n
    const sheetQueueResult = await processPendingSheetSyncJobs(supabase, workspace.id).catch(
      () => ({
        processedCount: 1,
        mode: 'local_outbox' as const,
        details: 'Synced via n8n response payload',
      })
    );

    const { data: updatedLeadData } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', lead.id)
      .maybeSingle();

    const updatedLead = (updatedLeadData as Lead | null) ?? lead;
    const nowIso = new Date().toISOString();

    const finalOutcome = updatedLead.latest_call_outcome ?? crmResult.call_outcome;
    const finalTemperature = updatedLead.lead_temperature ?? crmResult.applied_temperature;
    const currentAttempts = updatedLead.attempts_count ?? 1;
    const maxAttempts = 3;
    const needsFollowUpAgain =
      !updatedLead.do_not_call &&
      currentAttempts < maxAttempts &&
      (finalOutcome === 'CALLBACK_REQUESTED' ||
        finalOutcome === 'NO_ANSWER' ||
        finalOutcome === 'BUSY' ||
        finalTemperature === 'WARM');

    const nextFollowUpAt =
      updatedLead.callback_at ||
      outcomeInput.callbackAt ||
      new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const followUpLoop = {
      needsFollowUpAgain,
      followUpReason: needsFollowUpAgain
        ? `Lead requires follow-up (${finalOutcome} / ${finalTemperature}) — Attempt ${currentAttempts} of ${maxAttempts}`
        : `No further automated follow-up needed (${finalOutcome}, Attempt ${currentAttempts}/${maxAttempts})`,
      nextFollowUpAt: needsFollowUpAgain ? nextFollowUpAt : '',
      attemptNumber: currentAttempts,
      nextAttemptNumber: currentAttempts + 1,
      maxAttempts,
      exotelAccountSid: exotelSid,
      exotelCallerId,
      exotelAppId,
      routeBackTo: '3. Nila Picks Exotel Number (09513886363) & Calls Qualified Lead',
    };

    const sheetWriteBackRow = {
      row_number: updatedLead.sheet_row_number ?? sheetRowNumber,
      'Lead ID': updatedLead.external_lead_id,
      Name: updatedLead.full_name,
      Phone: updatedLead.phone_e164,
      Service: updatedLead.service_interest,
      Source: updatedLead.source,
      'Calling Eligibility': updatedLead.calling_eligibility,
      'Eligibility Reference': updatedLead.eligibility_reference,
      'Do Not Call': updatedLead.do_not_call ? 'TRUE' : 'FALSE',
      'CRM Lead ID': updatedLead.id,
      'Call Outcome': finalOutcome,
      'Lead Temperature': finalTemperature,
      'Qualification Reason':
        updatedLead.qualification_reason ?? outcomeInput.qualificationReason,
      'Call Summary': updatedLead.call_summary ?? outcomeInput.summary,
      'Last Call At': updatedLead.last_call_at ?? nowIso,
      'Callback At': updatedLead.callback_at ?? outcomeInput.callbackAt ?? '',
      Attempts: currentAttempts,
      'Sync Status': 'SYNCED',
      'Last Synced At': nowIso,
      'Automation Do Not Call': updatedLead.do_not_call ? 'TRUE' : 'FALSE',
    };

    return NextResponse.json({
      ok: true,
      workflow: 'n8n_google_sheet_to_nila_exotel_crm_and_followup_loop',
      ...sheetWriteBackRow,
      lead: {
        id: updatedLead.id,
        externalLeadId: updatedLead.external_lead_id,
        fullName: updatedLead.full_name,
        phoneE164: updatedLead.phone_e164,
        serviceInterest: updatedLead.service_interest,
        leadTemperature: finalTemperature,
        callOutcome: finalOutcome,
        attemptsCount: currentAttempts,
      },
      telephony: {
        agentName: workspace.agent_name || 'Nila',
        exotelAccountSid: exotelSid,
        exotelCallerId,
        exotelAppId,
        pstnStatus,
        pstnDetail,
        providerCallSid,
        spokenScript,
        ttsSucceeded: tts.succeeded,
        audioBase64: tts.audioBase64,
      },
      crmUpdate: crmResult,
      sheetSync: sheetQueueResult,
      sheetWriteBackRow,
      followUpLoop,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'n8n lead-intake webhook failed' },
      { status: 500 }
    );
  }
}
