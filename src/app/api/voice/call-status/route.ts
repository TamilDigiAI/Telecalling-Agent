import { NextResponse, type NextRequest } from 'next/server';
import {
  requireWorkspaceActionContext,
  WorkspaceAccessDeniedError,
} from '@/lib/auth/workspace-guard';
import type { CallAttempt } from '@/types/crm';
import type { UiCallState } from '@/app/api/voice/call-lead/route';

export const runtime = 'nodejs';

function mapAttemptToUiCallState(attempt: CallAttempt): {
  callState: UiCallState;
  providerVerified: boolean;
} {
  const hasProviderEvidence = Boolean(
    attempt.provider === 'vobiz_live' && (attempt.provider_request_uuid || attempt.provider_call_sid)
  );
  const raw = (attempt.provider_raw_status || attempt.status || '').toUpperCase();

  if (['FAILED', 'BUSY', 'NO_ANSWER', 'CANCELLED', 'INSUFFICIENT_BALANCE'].includes(raw)) {
    return { callState: 'Failed', providerVerified: hasProviderEvidence };
  }
  if (raw === 'COMPLETED') {
    return {
      callState: hasProviderEvidence ? 'Completed' : 'Failed',
      providerVerified: hasProviderEvidence,
    };
  }
  if (raw === 'IN_PROGRESS' || raw === 'ANSWERED') {
    return {
      callState: hasProviderEvidence ? 'Connected' : 'Dialing',
      providerVerified: hasProviderEvidence,
    };
  }
  if (raw === 'RINGING') {
    return { callState: 'Ringing', providerVerified: hasProviderEvidence };
  }
  if (raw === 'INITIATED' || raw === 'QUEUED') {
    return { callState: 'Dialing', providerVerified: hasProviderEvidence };
  }
  return { callState: 'Ready', providerVerified: false };
}

export async function GET(request: NextRequest) {
  try {
    const { supabase, workspace } = await requireWorkspaceActionContext();
    const attemptId = request.nextUrl.searchParams.get('attemptId')?.trim();
    if (!attemptId) {
      return NextResponse.json({ error: 'attemptId is required' }, { status: 400 });
    }

    const { data } = await supabase
      .from('call_attempts')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', attemptId)
      .maybeSingle();

    const attempt = data as CallAttempt | null;
    if (!attempt) {
      return NextResponse.json({ error: 'Call attempt not found' }, { status: 404 });
    }

    const mapped = mapAttemptToUiCallState(attempt);
    return NextResponse.json({
      ok: true,
      attemptId: attempt.id,
      provider: attempt.provider,
      providerCallSid: attempt.provider_request_uuid ?? attempt.provider_call_sid,
      providerRawStatus: attempt.provider_raw_status ?? attempt.status,
      callState: mapped.callState,
      providerVerified: mapped.providerVerified,
      reconciliationRequired: Boolean(attempt.reconciliation_required),
      error: attempt.status === 'FAILED' ? attempt.summary : null,
    });
  } catch (err) {
    if (err instanceof WorkspaceAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Status check failed' },
      { status: 500 }
    );
  }
}
