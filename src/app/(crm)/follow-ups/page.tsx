import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { listWorkspaceFollowUpTasks, listWorkspaceLeads } from '@/lib/crm/service';
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

export default async function FollowUpsPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace } = pageState.context;
  const [tasks, leads] = await Promise.all([
    listWorkspaceFollowUpTasks(supabase, workspace.id),
    listWorkspaceLeads(supabase, workspace.id),
  ]);
  const leadsById = new Map(leads.map((l) => [l.id, l]));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-[#0B1220]">Follow-ups</h1>
        <Link
          href="/assistant"
          className="px-3.5 py-2 rounded-lg border border-[#E2E8E2] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B1220]"
        >
          Schedule Follow-up
        </Link>
      </div>

      {tasks.length === 0 ? (
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-8 text-center text-sm text-slate-600">
          No follow-up tasks scheduled yet.
        </div>
      ) : (
        <div className="bg-white border border-[#E2E8E2] rounded-xl divide-y divide-[#E2E8E2]">
          {tasks.map((task) => {
            const lead = leadsById.get(task.lead_id);
            return (
              <div
                key={task.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/leads/${task.lead_id}`}
                      className="font-semibold text-sm text-[#0B1220] hover:text-[#149642]"
                    >
                      {task.title}
                    </Link>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        task.status === 'OPEN'
                          ? 'bg-[#FBB61B]/25 text-[#0B1220]'
                          : task.status === 'COMPLETED'
                            ? 'bg-[#149642]/15 text-[#0F7633]'
                            : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {task.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600">
                    {lead ? `${lead.full_name} (${lead.phone_e164}) · ` : ''}
                    Due {formatIst(task.due_at)} IST
                  </div>
                  {task.notes && <p className="text-xs text-slate-500">{task.notes}</p>}
                </div>

                {task.status === 'OPEN' && (
                  <form action={completeFollowUpTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <button
                      type="submit"
                      className="px-3.5 py-2 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-xs font-semibold cursor-pointer whitespace-nowrap"
                    >
                      Mark Done
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
