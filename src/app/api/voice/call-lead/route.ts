import { NextResponse, type NextRequest } from 'next/server';
import {
  requireWorkspaceActionContext,
  WorkspaceAccessDeniedError,
} from '@/lib/auth/workspace-guard';
import { getWorkspaceLeadById } from '@/lib/crm/service';
import { getServerVobizConfig } from '@/lib/env';
import { initiateVobizOutboundCall } from '@/lib/telephony/vobiz-client';
import { isWithinPermittedIstHours } from '@/lib/voice/qualification-validator';
import { synthesizeNilaAudioWithBulbul } from '@/lib/voice/sarvam-nila';
import type { CallAttempt, LeadSuppression } from '@/types/crm';

export const runtime = 'nodejs';

export type UiCallState = 'Ready' | 'Dialing' | 'Ringing' | 'Connected' | 'Completed' | 'Failed';

/**
 * POST /api/voice/call-lead
 * - mode === 'live' ("Call with Nila"):
 *   Checks eligibility, suppression, pause switch, permitted IST hours, pilot allowlist,
 *   and idempotencyKey (preventing double-click duplicate calls).
 *   Places a real Vobiz outbound call using VOBIZ_PHONE_NUMBER and returns:
 *     - callState: 'Dialing' ONLY when Vobiz returns a real request_uuid (providerVerified: true)
 *     - callState: 'Failed' with the actual error whenever Vobiz rejects or is unconfigured
 * - mode === 'preview' ("Voice preview"):
 *   Synthesizes Nila's browser Voice preview via Sarvam Bulbul v3 (speaker="ritu", language="ta-IN")
 *   without placing a PSTN call or faking a connected state.
 */
export async function POST(request: NextRequest) {
  try {
    const { supabase, workspace, user } = await requireWorkspaceActionContext();
    const body = (await request.json()) as {
      leadId?: string;
      mode?: 'live' | 'preview';
      idempotencyKey?: string;
    };

    if (!body.leadId) {
      return NextResponse.json({ error: 'leadId is required' }, { status: 400 });
    }

    const lead = await getWorkspaceLeadById(supabase, workspace.id, body.leadId);
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found in workspace' }, { status: 404 });
    }

    // Check Voice Preview mode first
    if (body.mode === 'preview') {
      const spokenScript = `வணக்கம்! நான் நிலா, DigiAnchorZ-ஓட AI assistant பேசுறேன். ${lead.full_name} அவர்களிடம் தான் பேசுறேனா? நீங்க ${lead.service_interest} பத்தி enquiry பண்ணிருந்தீங்க. இப்போ இரண்டு நிமிஷம் பேசலாமா?`;
      const tts = await synthesizeNilaAudioWithBulbul(spokenScript, {
        speakerOverride: 'ritu',
        languageOverride: 'ta-IN',
      });

      return NextResponse.json({
        ok: tts.succeeded,
        mode: 'preview',
        voicePreview: true,
        callState: 'Ready' as UiCallState,
        providerVerified: false,
        leadPhone: lead.phone_e164,
        leadName: lead.full_name,
        speaker: tts.speaker,
        languageCode: tts.languageCode,
        spokenScript,
        audioBase64: tts.audioBase64,
        mimeType: tts.mimeType,
        error: tts.error ?? null,
      });
    }

    // LIVE CALL MODE ("Call with Nila")
    // 1. Check current eligibility and suppression state
    if (lead.calling_eligibility !== 'ELIGIBLE') {
      return NextResponse.json(
        {
          ok: false,
          callState: 'Failed' as UiCallState,
          providerVerified: false,
          error: `Call blocked: ${lead.external_lead_id} calling eligibility is ${lead.calling_eligibility} (must be ELIGIBLE).`,
        },
        { status: 409 }
      );
    }

    const { data: supData } = await supabase
      .from('lead_suppressions')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('phone_e164', lead.phone_e164)
      .eq('active', true);

    const activeSuppression = ((supData ?? []) as LeadSuppression[])[0];
    if (lead.do_not_call || activeSuppression) {
      return NextResponse.json(
        {
          ok: false,
          callState: 'Failed' as UiCallState,
          providerVerified: false,
          error: `Call blocked: ${lead.phone_e164} is suppressed (DO_NOT_CALL).`,
        },
        { status: 409 }
      );
    }

    // 2. Check pause switch, permitted IST hours, and pilot allowlist
    if (workspace.dial_paused) {
      return NextResponse.json(
        {
          ok: false,
          callState: 'Failed' as UiCallState,
          providerVerified: false,
          error: 'Outbound dialing is paused in Workspace Controls.',
        },
        { status: 409 }
      );
    }

    const hoursCheck = isWithinPermittedIstHours(
      workspace.allowed_start_hour_ist ?? 9,
      workspace.allowed_end_hour_ist ?? 20
    );
    if (!hoursCheck.allowed) {
      return NextResponse.json(
        {
          ok: false,
          callState: 'Failed' as UiCallState,
          providerVerified: false,
          error: `Outside permitted calling hours (${workspace.allowed_start_hour_ist}:00–${workspace.allowed_end_hour_ist}:00 IST; current IST hour: ${hoursCheck.currentHourIst}:00).`,
        },
        { status: 409 }
      );
    }

    const allowlist = workspace.allowlist_phones ?? [];
    if (allowlist.length > 0 && !allowlist.includes(lead.phone_e164)) {
      return NextResponse.json(
        {
          ok: false,
          callState: 'Failed' as UiCallState,
          providerVerified: false,
          error: `${lead.phone_e164} is not in the approved Staff Pilot Allowlist.`,
        },
        { status: 403 }
      );
    }

    // 3. Prevent double-click duplicate calls via idempotencyKey
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const { data: existingAttempts } = await supabase
        .from('call_attempts')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('lead_id', lead.id);
      const dup = ((existingAttempts ?? []) as CallAttempt[]).find(
        (a) => a.idempotency_key === idempotencyKey
      );
      if (dup) {
        return NextResponse.json({
          ok: true,
          deduplicated: true,
          attemptId: dup.id,
          provider: dup.provider,
          providerCallSid: dup.provider_request_uuid ?? dup.provider_call_sid,
          providerVerified: Boolean(dup.provider_request_uuid),
          callState: dup.status === 'FAILED' ? 'Failed' : 'Dialing',
          message: 'Duplicate click ignored — existing call attempt returned.',
        });
      }
    }

    // 4. Verify Vobiz configuration & place real outbound call
    const vobizCfg = getServerVobizConfig();
    if (!vobizCfg.isConfigured) {
      return NextResponse.json(
        {
          ok: false,
          callState: 'Failed' as UiCallState,
          provider: 'vobiz_live',
          providerVerified: false,
          error:
            'Vobiz live credentials are not configured on the server (missing VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, or VOBIZ_PHONE_NUMBER).',
        },
        { status: 422 }
      );
    }

    const attemptId = crypto.randomUUID();
    const vobizRes = await initiateVobizOutboundCall({
      attemptId,
      toPhoneE164: lead.phone_e164,
      fromPhoneE164: vobizCfg.phoneNumber,
    });

    const nowIso = new Date().toISOString();
    const attemptNumber = (lead.attempts_count || 0) + 1;

    if (vobizRes.ok && vobizRes.requestUuid) {
      await supabase.from('call_attempts').insert({
        id: attemptId,
        workspace_id: workspace.id,
        lead_id: lead.id,
        attempt_number: attemptNumber,
        agent_name: workspace.agent_name || 'Nila',
        provider: 'vobiz_live',
        provider_call_sid: vobizRes.requestUuid,
        provider_request_uuid: vobizRes.requestUuid,
        provider_account_id: vobizCfg.authId,
        provider_raw_status: 'initiated',
        reconciliation_required: false,
        idempotency_key: idempotencyKey,
        direction: 'OUTBOUND',
        status: 'INITIATED',
        duration_seconds: 0,
        initiated_by_user_id: user.id,
        started_at: nowIso,
      });

      return NextResponse.json({
        ok: true,
        mode: 'live',
        attemptId,
        provider: 'vobiz_live',
        callerId: vobizCfg.phoneNumber,
        leadPhone: lead.phone_e164,
        leadName: lead.full_name,
        providerCallSid: vobizRes.requestUuid,
        providerVerified: true,
        callState: 'Dialing' as UiCallState,
        message: vobizRes.message,
      });
    }

    // Vobiz rejected or timed out — record actual failed/reconciling attempt and surface exact error
    await supabase.from('call_attempts').insert({
      id: attemptId,
      workspace_id: workspace.id,
      lead_id: lead.id,
      attempt_number: attemptNumber,
      agent_name: workspace.agent_name || 'Nila',
      provider: 'vobiz_live',
      provider_call_sid: vobizRes.requestUuid,
      provider_request_uuid: vobizRes.requestUuid,
      provider_account_id: vobizCfg.authId,
      provider_raw_status: vobizRes.status,
      provider_error_code: vobizRes.errorCode ?? null,
      reconciliation_required: vobizRes.reconciliationRequired,
      idempotency_key: idempotencyKey,
      direction: 'OUTBOUND',
      status: vobizRes.reconciliationRequired ? 'INITIATED' : 'FAILED',
      call_outcome: vobizRes.reconciliationRequired ? null : 'FAILED',
      summary: vobizRes.message,
      duration_seconds: 0,
      initiated_by_user_id: user.id,
      started_at: nowIso,
      ended_at: vobizRes.reconciliationRequired ? null : nowIso,
    });

    return NextResponse.json(
      {
        ok: false,
        mode: 'live',
        attemptId,
        provider: 'vobiz_live',
        providerVerified: false,
        callState: 'Failed' as UiCallState,
        reconciliationRequired: vobizRes.reconciliationRequired,
        errorCode: vobizRes.errorCode ?? null,
        error: vobizRes.message,
      },
      { status: vobizRes.status === 'insufficient_balance' ? 402 : 502 }
    );
  } catch (err) {
    if (err instanceof WorkspaceAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json(
      {
        ok: false,
        callState: 'Failed' as UiCallState,
        providerVerified: false,
        error: err instanceof Error ? err.message : 'Call failed',
      },
      { status: 500 }
    );
  }
}
