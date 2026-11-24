import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import {
  getWorkspaceLeadById,
  listWorkspaceCallAttempts,
  listWorkspaceFollowUpTasks,
  listWorkspaceSheetSyncJobs,
} from '@/lib/crm/service';
import { CallWithNilaButton } from '@/components/leads/CallWithNilaButton';
import { completeFollowUpTaskAction } from '@/app/actions/crm';
import { isPilotTestContact } from '@/lib/pilot/test-contacts';

function formatIst(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { id } = await params;
  const { supabase, workspace, membership } = pageState.context;

  const lead = await getWorkspaceLeadById(supabase, workspace.id, id);
  if (!lead) {
    notFound();
  }

  const [attempts, allTasks, allSyncJobs] = await Promise.all([
    listWorkspaceCallAttempts(supabase, workspace.id, lead.id),
    listWorkspaceFollowUpTasks(supabase, workspace.id),
    listWorkspaceSheetSyncJobs(supabase, workspace.id),
  ]);

  const leadTasks = allTasks.filter((t) => t.lead_id === lead.id);
  const leadSyncJobs = allSyncJobs.filter((j) => j.lead_id === lead.id);
  const isOwner = membership.role === 'owner';

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/leads" className="text-xs font-semibold text-[#149642] hover:underline">
          &larr; Back to Leads
        </Link>

        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 bg-white border border-[#E2E8E2] rounded-xl p-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-[#0B1220]">{lead.full_name}</h1>
              {isPilotTestContact(lead.external_lead_id) && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-800 border border-indigo-200">
                  Test Contact
                </span>
              )}
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#149642]/15 text-[#0F7633]">
                {lead.do_not_call ? 'Do Not Call' : lead.lead_temperature}
              </span>
            </div>
            <div className="text-sm text-slate-600">
              <span className="font-mono">{lead.phone_e164}</span> · {lead.service_interest}
            </div>
          </div>

          <CallWithNilaButton
            leadId={lead.id}
            phoneE164={lead.phone_e164}
            eligible={lead.calling_eligibility === 'ELIGIBLE'}
            doNotCall={lead.do_not_call}
          />
        </div>
      </div>

      {/* Latest Call Summary, Qualification Reason, Next Action, Follow-up Time */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase text-slate-500">Latest Call Summary</div>
          <p className="text-[#0B1220]">{lead.call_summary || 'No call summary yet.'}</p>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase text-slate-500">Qualification Reason</div>
          <p className="text-[#0B1220]">
            {lead.qualification_reason || 'Not yet qualified.'}
          </p>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase text-slate-500">Next Action</div>
          <p className="text-[#0B1220]">{lead.next_action || '—'}</p>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase text-slate-500">Follow-up Time (IST)</div>
          <p className="text-[#0B1220]">{formatIst(lead.callback_at)}</p>
        </div>
      </section>

      {/* Open Follow-ups for this Lead */}
      {leadTasks.length > 0 && (
        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
          <h2 className="text-base font-bold text-[#0B1220]">Follow-ups</h2>
          <div className="divide-y divide-[#E2E8E2]">
            {leadTasks.map((task) => (
              <div
                key={task.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div>
                  <div className="font-semibold text-sm text-[#0B1220]">{task.title}</div>
                  <div className="text-xs text-slate-600">
                    {formatIst(task.due_at)} IST · {task.status}
                  </div>
                </div>
                {task.status === 'OPEN' && (
                  <form action={completeFollowUpTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-xs font-semibold cursor-pointer"
                    >
                      Mark Done
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Call History */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
        <h2 className="text-base font-bold text-[#0B1220]">
          Call History ({attempts.length})
        </h2>
        {attempts.length === 0 ? (
          <p className="text-sm text-slate-500">No calls placed to this lead yet.</p>
        ) : (
          <div className="divide-y divide-[#E2E8E2]">
            {attempts.map((attempt) => (
              <div key={attempt.id} className="py-3.5 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-[#0B1220]">
                      Attempt #{attempt.attempt_number}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#FBB61B]/25 text-[#0B1220]">
                      {attempt.call_outcome ?? attempt.status}
                    </span>
                    {attempt.applied_temperature && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#149642]/15 text-[#0F7633]">
                        {attempt.applied_temperature}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {formatIst(attempt.started_at)} · {attempt.duration_seconds}s
                  </span>
                </div>
                {attempt.summary && <p className="text-xs text-slate-700">{attempt.summary}</p>}
                {attempt.qualification_reason && (
                  <p className="text-xs text-slate-500">{attempt.qualification_reason}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Owner-Only Technical Details */}
      {isOwner && (
        <details className="bg-white border border-[#E2E8E2] rounded-xl p-5 text-xs">
          <summary className="font-bold text-sm text-[#0B1220] cursor-pointer select-none">
            Technical Details (Owner Only)
          </summary>
          <div className="mt-4 space-y-4 text-slate-700">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px] bg-[#F7F9F6] p-3 rounded-lg border border-[#E2E8E2]">
              <div>CRM Lead ID: {lead.id}</div>
              <div>Source Lead ID: {lead.external_lead_id}</div>
              <div>Sheet ID: {lead.sheet_id}</div>
              <div>
                Sheet Tab / Row: {lead.sheet_tab} / {lead.sheet_row_number ?? '—'}
              </div>
              <div>Eligibility: {lead.calling_eligibility} ({lead.eligibility_reference})</div>
              <div>
                Sync Status: {lead.sync_status} (Last synced: {lead.last_synced_at ?? 'Never'})
              </div>
              {lead.sync_error && (
                <div className="md:col-span-2 text-red-700">Sync Error: {lead.sync_error}</div>
              )}
            </div>

            {attempts.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-semibold text-[#0B1220]">Provider Call Traces</div>
                {attempts.map((a) => (
                  <div
                    key={a.id}
                    className="p-2.5 rounded bg-[#F7F9F6] border border-[#E2E8E2] font-mono text-[11px] space-y-0.5"
                  >
                    <div>
                      Attempt #{a.attempt_number} · Provider: {a.provider} · Raw Status:{' '}
                      {a.provider_raw_status ?? a.status} · ID:{' '}
                      {a.provider_request_uuid ?? a.provider_call_sid ?? 'none'}
                    </div>
                    {a.reconciliation_required && (
                      <div className="text-amber-800">Reconciliation Required: true</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {leadSyncJobs.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-semibold text-[#0B1220]">Sheet Sync Diagnostics</div>
                {leadSyncJobs.map((j) => (
                  <div
                    key={j.id}
                    className="p-2.5 rounded bg-[#F7F9F6] border border-[#E2E8E2] font-mono text-[11px]"
                  >
                    {j.operation} · {j.status} · Attempts: {j.attempts}/{j.max_attempts} · Key:{' '}
                    {j.idempotency_key}
                    {j.last_error ? ` · Error: ${j.last_error}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
