import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_WORKSPACE_SLUG } from '@/lib/env';
import { getServerAutomationSupabaseClient, verifyN8nBackendAuth } from '@/lib/n8n/auth';
import type { Lead, SheetSyncJob, Workspace } from '@/types/crm';

export const runtime = 'nodejs';

/**
 * POST /api/n8n/sheet-sync/claim
 * Invoked by n8n Workflow B ("Nila — Sheet Write-back").
 * Claims pending/retryable sheet sync jobs with an expiring lease and strict per-lead ordering
 * (at most one active lease per lead; oldest pending job first).
 */
export async function POST(request: NextRequest) {
  try {
    if (!verifyN8nBackendAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized n8n request' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      workerId?: string;
      leaseSeconds?: number;
      limit?: number;
      workspaceSlug?: string;
    };

    const workerId = String(body.workerId || `n8n-sheet-worker-${crypto.randomUUID().slice(0, 8)}`);
    const leaseSeconds = Math.min(600, Math.max(30, Number(body.leaseSeconds || 120)));
    const limit = Math.min(50, Math.max(1, Number(body.limit || 10)));
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

    const [{ data: allJobsData }, { data: leadsData }] = await Promise.all([
      supabase.from('sheet_sync_jobs').select('*').eq('workspace_id', workspace.id),
      supabase.from('leads').select('*').eq('workspace_id', workspace.id),
    ]);

    const allJobs = (allJobsData ?? []) as SheetSyncJob[];
    const leadsById = new Map(((leadsData ?? []) as Lead[]).map((l) => [l.id, l]));
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();

    // Identify leads that already have an active unexpired PROCESSING lease
    const busyLeadIds = new Set<string>();
    for (const j of allJobs) {
      if (
        j.status === 'PROCESSING' &&
        j.lease_expires_at &&
        new Date(j.lease_expires_at).getTime() > nowMs
      ) {
        busyLeadIds.add(j.lead_id);
      }
    }

    // Eligible jobs: PENDING, retryable FAILED (next_attempt_at <= now), or expired-lease PROCESSING
    // Ordered oldest-first so per-lead updates execute in deterministic order
    const eligible = allJobs
      .filter((j) => {
        if (busyLeadIds.has(j.lead_id)) return false;
        if (j.attempts >= j.max_attempts) return false;
        if (j.status === 'PENDING') {
          return !j.next_attempt_at || new Date(j.next_attempt_at).getTime() <= nowMs;
        }
        if (j.status === 'FAILED') {
          return !j.next_attempt_at || new Date(j.next_attempt_at).getTime() <= nowMs;
        }
        if (j.status === 'PROCESSING') {
          return !j.lease_expires_at || new Date(j.lease_expires_at).getTime() <= nowMs;
        }
        return false;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const claimedJobs: Array<{
      jobId: string;
      leaseToken: string;
      leaseExpiresAt: string;
      sheetId: string;
      sheetTab: string;
      sheetRowNumber: number | null;
      externalLeadId: string;
      rowBoundKey: string | null;
      crmLeadId: string;
      operation: string;
      valueInputOption: 'RAW';
      automationColumnsJToT: Record<string, string>;
    }> = [];

    const claimedLeadIds = new Set<string>();

    for (const job of eligible) {
      if (claimedJobs.length >= limit) break;
      if (claimedLeadIds.has(job.lead_id)) continue; // Strict per-lead ordering: 1 active job per lead

      const lead = leadsById.get(job.lead_id);
      if (!lead) continue;

      const leaseToken = `${workerId}:${crypto.randomUUID().slice(0, 8)}`;

      await supabase
        .from('sheet_sync_jobs')
        .update({
          status: 'PROCESSING',
          locked_by: leaseToken,
          lease_expires_at: leaseExpiresAt,
        })
        .eq('workspace_id', workspace.id)
        .eq('id', job.id);

      claimedLeadIds.add(job.lead_id);

      // Exact Automation Columns J:T (all serialized as strings for valueInputOption=RAW)
      claimedJobs.push({
        jobId: job.id,
        leaseToken,
        leaseExpiresAt,
        sheetId: job.sheet_id || lead.sheet_id,
        sheetTab: job.sheet_tab || lead.sheet_tab || 'Leads',
        sheetRowNumber: job.sheet_row_number ?? lead.sheet_row_number,
        externalLeadId: lead.external_lead_id,
        rowBoundKey: lead.row_bound_key ?? `${lead.external_lead_id}::${lead.phone_e164}`,
        crmLeadId: lead.id,
        operation: job.operation,
        valueInputOption: 'RAW',
        automationColumnsJToT: {
          'CRM Lead ID': lead.id,
          'Call Outcome': lead.latest_call_outcome ?? '',
          'Lead Temperature': lead.lead_temperature,
          'Qualification Reason': lead.qualification_reason ?? '',
          'Call Summary': lead.call_summary ?? '',
          'Last Call At': lead.last_call_at ?? nowIso,
          'Callback At': lead.callback_at ?? '',
          Attempts: String(lead.attempts_count ?? 0),
          'Sync Status': 'SYNCED',
          'Last Synced At': nowIso,
          'Automation Do Not Call': lead.do_not_call ? 'TRUE' : 'FALSE',
        },
      });
    }

    return NextResponse.json({
      ok: true,
      workspaceId: workspace.id,
      workerId,
      claimedCount: claimedJobs.length,
      jobs: claimedJobs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to claim sheet sync jobs' },
      { status: 500 }
    );
  }
}
