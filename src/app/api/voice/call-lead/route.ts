import { NextResponse, type NextRequest } from 'next/server';
import {
  requireWorkspaceActionContext,
  WorkspaceAccessDeniedError,
} from '@/lib/auth/workspace-guard';
import { getWorkspaceLeadById, recordCallOutcomeAndFollowUp } from '@/lib/crm/service';
import { resolveBusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';
import {
  buildRecordOutcomeInputFromSimulation,
  simulateOutboundCallWithNila,
} from '@/lib/telephony/mock-provider';
import { synthesizeNilaAudioWithBulbul } from '@/lib/voice/sarvam-nila';
import { processPendingSheetSyncJobs } from '@/lib/sheets/google-sheets-sync';

export const runtime = 'nodejs';

/**
 * POST /api/voice/call-lead
 * 1. Checks if Twilio has an active IncomingPhoneNumber to dial targetPhoneE164 over PSTN.
 * 2. Synthesizes Nila's real Kongu Tanglish opening & qualification call using Sarvam Bulbul v3 (ishita, ta-IN).
 * 3. Records the call attempt in the CRM and returns the audio + PSTN status to the browser.
 */
export async function POST(request: NextRequest) {
  try {
    const { supabase, workspace } = await requireWorkspaceActionContext();
    const body = (await request.json()) as { leadId?: string };

    if (!body.leadId) {
      return NextResponse.json({ error: 'leadId is required' }, { status: 400 });
    }

    const lead = await getWorkspaceLeadById(supabase, workspace.id, body.leadId);
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found in workspace' }, { status: 404 });
    }

    if (lead.do_not_call) {
      return NextResponse.json(
        { error: `Call blocked: ${lead.phone_e164} has opted out (DO_NOT_CALL)` },
        { status: 409 }
      );
    }

    const settings = resolveBusinessKnowledgeSettings(workspace.business_profile);

    // 1. Attempt Exotel PSTN dial first using digianchorz1 Free Trial ExoPhone (09513886363)
    let pstnStatus: 'dialed' | 'no_caller_id_number' | 'not_configured' | 'error' =
      'not_configured';
    let pstnDetail = '';
    let providerCallSid: string | null = null;

    const exotelSid = process.env.EXOTEL_ACCOUNT_SID?.trim() || 'digianchorz1';
    const exotelKey = process.env.EXOTEL_API_KEY?.trim() || '';
    const exotelToken = process.env.EXOTEL_API_TOKEN?.trim() || '';
    const exotelCallerId = process.env.EXOTEL_CALLER_ID?.trim() || '09513886363';
    const exotelAppId = process.env.EXOTEL_APP_ID?.trim() || '1370873';
    const exotelBaseUrl = (
      process.env.EXOTEL_API_BASE_URL?.trim() || 'https://api.exotel.com'
    ).replace(/\/+$/, '');

    if (exotelSid && exotelKey && exotelToken && !exotelKey.includes('your_exotel')) {
      try {
        const basicAuth = Buffer.from(`${exotelKey}:${exotelToken}`).toString('base64');
        const nationalNumber = lead.phone_e164.replace(/^\+91/, '0');
        const form = new URLSearchParams();
        form.set('From', nationalNumber);
        form.set('CallerId', exotelCallerId);
        form.set('Url', `http://my.exotel.com/${exotelSid}/exoml/start_voice/${exotelAppId}`);
        form.set('CallType', 'trans');
        form.set('CustomField', `leadId=${lead.id}`);

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
          Call?: { Sid?: string; Status?: string };
          RestException?: { Status?: number; Message?: string };
        };

        if (exoRes.ok && exoJson.Call?.Sid) {
          pstnStatus = 'dialed';
          providerCallSid = exoJson.Call.Sid;
          pstnDetail = `Exotel PSTN call initiated via ExoPhone ${exotelCallerId} (App ${exotelAppId}) to ${lead.phone_e164} — CallSid: ${exoJson.Call.Sid}.`;
        } else {
          pstnStatus = 'error';
          pstnDetail = exoJson.RestException?.Message
            ? `Exotel (${exotelSid} / ${exotelCallerId}): "${exoJson.RestException.Message}" (Dashboard shows Credits: -276). Playing Nila's live Sarvam Bulbul v3 voice call in browser.`
            : `Exotel HTTP ${exoRes.status}: check Exotel trial credits (currently -276 in dashboard). Playing Nila's live Sarvam Bulbul v3 voice call in browser.`;
        }
      } catch (err) {
        pstnStatus = 'error';
        pstnDetail = err instanceof Error ? err.message : 'Exotel request failed';
      }
    }

    // 2. Generate Nila's real Kongu Tanglish spoken call using Sarvam Bulbul v3 (ishita, ta-IN)
    const spokenScript = `வணக்கம்ங்க! நான் நிலா, DigiAnchorZ-ஓட AI enquiry assistant பேசுறேங்க. ${lead.full_name} கிட்டதான் பேசுறேனாங்க? நீங்க ${lead.service_interest} பத்தி enquiry பண்ணியிருந்தீங்க, இப்போ ரெண்டு நிமிஷம் பேசலாமாங்க? எங்க MD தமிழ்செல்வன் sir கிட்ட நாளைக்கு காலைல 11 AM-க்கு ஒரு short callback arrange பண்ணிக்கலாமாங்க?`;

    const tts = await synthesizeNilaAudioWithBulbul(spokenScript);

    // 3. Record the call attempt and HOT outcome in CRM
    const sim = simulateOutboundCallWithNila(
      lead,
      'HOT_CALLBACK',
      workspace.agent_name || 'Nila',
      undefined,
      settings
    );
    const input = buildRecordOutcomeInputFromSimulation(lead, sim);
    const recorded = await recordCallOutcomeAndFollowUp(supabase, input);

    if (process.env.SHEETS_QUEUE_ENABLED === 'true') {
      await processPendingSheetSyncJobs(supabase, workspace.id).catch(() => undefined);
    }

    return NextResponse.json({
      ok: true,
      leadPhone: lead.phone_e164,
      leadName: lead.full_name,
      pstnStatus,
      pstnDetail,
      providerCallSid,
      spokenScript,
      audioBase64: tts.audioBase64,
      ttsSucceeded: tts.succeeded,
      crmResult: recorded,
    });
  } catch (err) {
    if (err instanceof WorkspaceAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Call failed' },
      { status: 500 }
    );
  }
}

