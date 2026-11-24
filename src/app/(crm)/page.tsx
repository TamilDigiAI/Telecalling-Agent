import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import {
  listWorkspaceCallAttempts,
  listWorkspaceFollowUpTasks,
  listWorkspaceIntegrationErrors,
  listWorkspaceLeads,
  listWorkspaceSheetSyncJobs,
} from '@/lib/crm/service';
import { completeFollowUpTaskAction } from '@/app/actions/crm';

function formatIst(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default async function OverviewPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace } = pageState.context;
  const [leads, openTasks, callAttempts, syncJobs, integrationErrors] = await Promise.all([
    listWorkspaceLeads(supabase, workspace.id),
    listWorkspaceFollowUpTasks(supabase, workspace.id, 'OPEN'),
    listWorkspaceCallAttempts(supabase, workspace.id),
    listWorkspaceSheetSyncJobs(supabase, workspace.id),
    listWorkspaceIntegrationErrors(supabase, workspace.id),
  ]);

  const leadsById = new Map(leads.map((l) => [l.id, l]));
  const hotLeads = leads.filter((l) => l.lead_temperature === 'HOT');
  const recentCalls = callAttempts.slice(0, 6);
  const failedSyncs = syncJobs.filter((j) => j.status === 'FAILED' || j.status === 'DEAD_LETTER');
  const openErrors = integrationErrors.filter((e) => !e.resolved);
  const totalFailures = failedSyncs.length + openErrors.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl font-bold text-[#0B1220]">Overview</h1>
        <Link
          href="/leads"
          className="px-4 py-2 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-sm font-semibold w-fit"
        >
          Open Leads
        </Link>
      </div>

      {/* Failures requiring founder attention */}
      {totalFailures > 0 && (
        <section
          aria-label="Failures requiring attention"
          className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-red-950">
              Attention Required ({totalFailures})
            </h2>
            <Link href="/settings" className="text-xs font-semibold text-red-900 underline">
              Troubleshoot in Settings &rarr;
            </Link>
          </div>
          <ul className="space-y-1 text-xs text-red-900">
            {openErrors.slice(0, 3).map((err) => (
              <li key={err.id}>
                <strong>{err.workflow_name || err.source}:</strong> {err.sanitized_message}
              </li>
            ))}
            {failedSyncs.slice(0, 3).map((job) => (
              <li key={job.id}>
                <strong>Google Sheet sync failed:</strong> {job.last_error || 'Retry pending'}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 1. Hot Leads */}
        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#0B1220]">Hot Leads ({hotLeads.length})</h2>
            <Link
              href="/leads?temperature=HOT"
              className="text-xs font-semibold text-[#149642] hover:underline"
            >
              View all &rarr;
            </Link>
          </div>
          {hotLeads.length === 0 ? (
            <p className="text-sm text-slate-500">No hot leads yet.</p>
          ) : (
            <div className="divide-y divide-[#E2E8E2]">
              {hotLeads.slice(0, 6).map((lead) => (
                <Link
                  key={lead.id}
                  href={`/leads/${lead.id}`}
                  className="py-3 flex items-center justify-between gap-3 hover:bg-[#F7F9F6] -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-[#0B1220] truncate">
                      {lead.full_name}
                    </div>
                    <div className="text-xs text-slate-600 truncate">
                      {lead.phone_e164} · {lead.service_interest}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-slate-600 whitespace-nowrap">
                    {formatIst(lead.callback_at)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* 2. Follow-ups Due */}
        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#0B1220]">
              Follow-ups Due ({openTasks.length})
            </h2>
            <Link
              href="/follow-ups"
              className="text-xs font-semibold text-[#149642] hover:underline"
            >
              Manage all &rarr;
            </Link>
          </div>
          {openTasks.length === 0 ? (
            <p className="text-sm text-slate-500">No follow-ups due.</p>
          ) : (
            <div className="divide-y divide-[#E2E8E2]">
              {openTasks.slice(0, 6).map((task) => (
                <div
                  key={task.id}
                  className="py-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/leads/${task.lead_id}`}
                      className="text-sm font-semibold text-[#0B1220] hover:underline block truncate"
                    >
                      {task.title}
                    </Link>
                    <div className="text-xs text-slate-600">{formatIst(task.due_at)} IST</div>
                  </div>
                  <form action={completeFollowUpTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg border border-[#E2E8E2] hover:bg-[#F7F9F6] text-xs font-semibold text-[#0B1220] cursor-pointer whitespace-nowrap"
                    >
                      Mark Done
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 3. Recent Call Activity */}
        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3 lg:col-span-2">
          <h2 className="text-base font-bold text-[#0B1220]">Recent Call Activity</h2>
          {recentCalls.length === 0 ? (
            <p className="text-sm text-slate-500">No calls recorded yet.</p>
          ) : (
            <div className="divide-y divide-[#E2E8E2]">
              {recentCalls.map((attempt) => {
                const lead = leadsById.get(attempt.lead_id);
                return (
                  <Link
                    key={attempt.id}
                    href={`/leads/${attempt.lead_id}`}
                    className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 hover:bg-[#F7F9F6] -mx-2 px-2 rounded-lg transition-colors"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-[#0B1220]">
                          {lead?.full_name || 'Lead'}
                        </span>
                        <span className="text-xs font-mono text-slate-500">
                          {lead?.phone_e164 || ''}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FBB61B]/25 text-[#0B1220]">
                          {attempt.call_outcome ?? attempt.status}
                        </span>
                        {attempt.applied_temperature && (
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#149642]/15 text-[#0F7633]">
                            {attempt.applied_temperature}
                          </span>
                        )}
                      </div>
                      {attempt.summary && (
                        <p className="text-xs text-slate-600 truncate">{attempt.summary}</p>
                      )}
                    </div>
                    <span className="text-xs text-slate-500 whitespace-nowrap">
                      {formatIst(attempt.started_at)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
