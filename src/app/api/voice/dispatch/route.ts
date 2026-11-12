import { NextResponse, type NextRequest } from 'next/server';
import {
  requireWorkspaceActionContext,
  WorkspaceAccessDeniedError,
} from '@/lib/auth/workspace-guard';
import { getWorkspaceLeadById } from '@/lib/crm/service';
import { dispatchAuthenticatedCallToVoiceService } from '@/lib/voice/voice-service-client';

/**
 * Protected CRM Route: POST /api/voice/dispatch
 * Requires authenticated founder session & workspace membership, then calls the Cloud Run
 * voice service with an HMAC-signed server-side payload.
 */
export async function POST(request: NextRequest) {
  try {
    const { supabase, workspace, user } = await requireWorkspaceActionContext();
    const body = (await request.json()) as {
      leadId?: string;
      attemptId?: string;
    };

    if (!body.leadId) {
      return NextResponse.json({ error: 'leadId is required' }, { status: 400 });
    }

    const lead = await getWorkspaceLeadById(supabase, workspace.id, body.leadId);
    if (!lead) {
      return NextResponse.json(
        { error: 'Lead not found in current workspace' },
        { status: 404 }
      );
    }

    if (lead.do_not_call) {
      return NextResponse.json(
        { error: 'Call blocked: lead has opted out (DO_NOT_CALL)' },
        { status: 409 }
      );
    }

    const attemptId = body.attemptId || crypto.randomUUID();
    const dispatchRes = await dispatchAuthenticatedCallToVoiceService({
      workspaceId: workspace.id,
      actorUserId: user.id,
      attemptId,
      leadId: lead.id,
      phoneE164: lead.phone_e164,
    });

    return NextResponse.json(dispatchRes.data, { status: dispatchRes.status });
  } catch (err) {
    if (err instanceof WorkspaceAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Dispatch error' },
      { status: 500 }
    );
  }
}
