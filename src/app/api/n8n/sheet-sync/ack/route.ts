import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_WORKSPACE_SLUG } from '@/lib/env';
import {
  getServerAutomationSupabaseClient,
  sanitizeIntegrationErrorMessage,
  verifyN8nBackendAuth,
} from '@/lib/n8n/auth';
import type { SheetSyncJob, Workspace } from '@/types/crm';

export const runtime = 'nodejs';

/**
 * POST /api/n8n/sheet-sync/ack
 * Invoked by n8n Workflow B ("Nila — Sheet Write-back") after writing columns J:T as RAW
 * or encountering a write/matching error.
 * Failed writes remain retryable WITHOUT redialing the lead.
 */
export async function POST(request: NextRequest) {
  try {
    if (!verifyN8nBackendAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized n8n request' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      jobId?: string;
      leaseToken?: string;
      status?: 'SUCCEEDED' | 'FAILED';
      matchedRowNumber?: number;
      error?: string;
      workspaceSlug?: string;
    };

    if (!body.jobId || !body.status) {
      return NextResponse.json(
        { error: 'jobId and status ("SUCCEEDED" | "FAILED") are required' },
        { status: 400 }
      );
    }

    const workspaceSlug = body.workspaceSlug?.trim() || DEFAULT_WORKSPACE_SLUG;
    const supabase = await getServerAutomationSupabaseClient();

    const { data: wsData } = await supabase
      .from('workspaces')
      .select('*')
      .eq('slug', workspaceSlug)
      .maybeSingle();

    const workspace = wsData as Workspace | null;
    if (!workspace) {
      return NextResponse.json({ error: `Workspace "${workspaceSlug}" not found` }, { status: 404 });
    }

    const { data: jobData } = await supabase
      .from('sheet_sync_jobs')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('id', body.jobId)
      .maybeSingle();

    const job = jobData as SheetSyncJob | null;
    if (!job) {
      return NextResponse.json({ error: 'Sheet sync job not found' }, { status: 404 });
    }

    // Verify lease token if provided
    if (body.leaseToken && job.locked_by && job.locked_by !== body.leaseToken) {
      return NextResponse.json(
        { error: 'Lease token mismatch: job lease was reclaimed by another worker' },
        { status: 409 }
      );
    }

    const nowIso = new Date().toISOString();
    const nextAttempts = (job.attempts || 0) + 1;

    if (body.status === 'SUCCEEDED') {
      await supabase
        .from('sheet_sync_jobs')
        .update({
          status: 'SUCCEEDED',
          attempts: nextAttempts,
          locked_by: null,
          lease_expires_at: null,
          completed_at: nowIso,
          last_error: null,
          sheet_row_number: body.matchedRowNumber ?? job.sheet_row_number,
        })
        .eq('workspace_id', workspace.id)
        .eq('id', job.id);

      await supabase
        .from('leads')
        .update({
          sync_status: 'SYNCED',
          last_synced_at: nowIso,
          sync_error: null,
          sheet_row_number: body.matchedRowNumber ?? job.sheet_row_number,
        })
        .eq('workspace_id', workspace.id)
        .eq('id', job.lead_id);

      return NextResponse.json({
        ok: true,
        jobId: job.id,
        status: 'SUCCEEDED',
        leadId: job.lead_id,
        redialTriggered: false,
      });
    }

    // FAILED write: schedule retry with exponential backoff — NEVER redial the lead
    const sanitizedError = sanitizeIntegrationErrorMessage(
      body.error || 'Google Sheets write-back failed'
    );
    const isDeadLetter = nextAttempts >= (job.max_attempts || 5);
    const backoffSeconds = Math.min(900, 30 * Math.pow(2, nextAttempts - 1));
    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

    await supabase
      .from('sheet_sync_jobs')
      .update({
        status: isDeadLetter ? 'DEAD_LETTER' : 'FAILED',
        attempts: nextAttempts,
        locked_by: null,
        lease_expires_at: null,
        next_attempt_at: nextAttemptAt,
        last_error: sanitizedError,
      })
      .eq('workspace_id', workspace.id)
      .eq('id', job.id);

    await supabase
      .from('leads')
      .update({
        sync_status: 'FAILED',
        sync_error: sanitizedError,
      })
      .eq('workspace_id', workspace.id)
      .eq('id', job.lead_id);

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: isDeadLetter ? 'DEAD_LETTER' : 'FAILED',
      retryable: !isDeadLetter,
      nextAttemptAt,
      leadId: job.lead_id,
      redialTriggered: false,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to acknowledge sheet sync job' },
      { status: 500 }
    );
  }
}
