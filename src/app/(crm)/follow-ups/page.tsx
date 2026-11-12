import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { listWorkspaceFollowUpTasks } from '@/lib/crm/service';
import { completeFollowUpTaskAction } from '@/app/actions/crm';

export default async function FollowUpsPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace } = pageState.context;
  const tasks = await listWorkspaceFollowUpTasks(supabase, workspace.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0B1220]">Founder Follow-Up Tasks</h1>
        <p className="text-sm text-slate-600">
          Enforced uniqueness: 1 callback task per call attempt within workspace{' '}
          <strong>{workspace.name}</strong>.
        </p>
      </div>

      {tasks.length === 0 ? (
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-6 text-sm text-slate-600">
          No follow-up tasks scheduled yet. Save a HOT call outcome on a lead to create a callback task.
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="bg-white border border-[#E2E8E2] rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-[#0B1220]">{task.title}</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#F7F9F6] border border-[#E2E8E2]">
                    {task.status}
                  </span>
                </div>
                <div className="text-xs text-slate-600">
                  Due At (UTC): <code className="font-mono">{task.due_at}</code> · Type:{' '}
                  <strong>{task.task_type}</strong>
                </div>
                {task.notes && <p className="text-xs text-slate-500">{task.notes}</p>}
              </div>

              {task.status === 'OPEN' && (
                <form action={completeFollowUpTaskAction}>
                  <input type="hidden" name="taskId" value={task.id} />
                  <button
                    type="submit"
                    className="px-3.5 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-xs font-semibold cursor-pointer"
                  >
                    Mark Complete
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

