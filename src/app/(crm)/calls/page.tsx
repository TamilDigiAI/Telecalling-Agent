import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { listWorkspaceCallAttempts } from '@/lib/crm/service';

export default async function CallsPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace } = pageState.context;
  const attempts = await listWorkspaceCallAttempts(supabase, workspace.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0B1220]">Call Attempts Log</h1>
        <p className="text-sm text-slate-600">
          Mock Exotel AgentStream + Sarvam Tanglish Voice Agent: <strong>{workspace.agent_name}</strong>
        </p>
      </div>

      {attempts.length === 0 ? (
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-6 text-sm text-slate-600">
          No call attempts recorded yet. Trigger a mock call from the Leads page.
        </div>
      ) : (
        <div className="space-y-3">
          {attempts.map((attempt) => (
            <div
              key={attempt.id}
              className="bg-white border border-[#E2E8E2] rounded-xl p-4 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-[#0B1220]">
                    Attempt #{attempt.attempt_number} · Agent {attempt.agent_name}
                  </span>
                  <span className="px-2 py-0.5 rounded text-xs font-mono bg-[#F7F9F6] border border-[#E2E8E2]">
                    {attempt.provider}
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#149642]/15 text-[#0F7633]">
                    {attempt.applied_temperature ?? 'UNQUALIFIED'}
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FBB61B]/25 text-[#0B1220]">
                    {attempt.call_outcome ?? attempt.status}
                  </span>
                </div>
                <span className="text-xs font-mono text-slate-500">
                  SID: {attempt.provider_call_sid} · {attempt.duration_seconds}s
                </span>
              </div>
              {attempt.summary && <p className="text-xs text-slate-700">{attempt.summary}</p>}
              {attempt.qualification_reason && (
                <p className="text-xs text-slate-500">Reason: {attempt.qualification_reason}</p>
              )}
              <div className="text-[11px] text-slate-400 font-mono">
                Started: {attempt.started_at} · Ended: {attempt.ended_at ?? 'In progress'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

