import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import {
  getWorkspaceOverview,
  listWorkspaceFollowUpTasks,
  listWorkspaceLeads,
} from '@/lib/crm/service';
import { runMockOutboundCallAction } from '@/app/actions/crm';
import { LiveNilaCallButton } from '@/components/leads/LiveNilaCallButton';

export default async function OverviewPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace } = pageState.context;
  const [stats, leads, openTasks] = await Promise.all([
    getWorkspaceOverview(supabase, workspace.id),
    listWorkspaceLeads(supabase, workspace.id),
    listWorkspaceFollowUpTasks(supabase, workspace.id, 'OPEN'),
  ]);

  const recentLeads = leads.slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#0B1220]">
            {workspace.name} · Founder Overview
          </h1>
          <p className="text-sm text-slate-600">
            Tanglish AI Enquiry Assistant: <strong>{workspace.agent_name}</strong> · Google Sheet:{' '}
            <code className="font-mono text-xs">{workspace.google_sheet_id}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-[#FBB61B]/25 text-[#0B1220] border border-[#FBB61B]">
            Outbound Calling: {workspace.telephony_mode.toUpperCase()}
          </span>
          <Link
            href="/leads"
            className="px-4 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-sm font-semibold"
          >
            View Leads
          </Link>
        </div>
      </div>

      <section aria-label="Workspace KPIs" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">Total Leads</div>
          <div className="text-2xl font-bold text-[#0B1220] mt-1">{stats.totalLeads}</div>
          <div className="text-xs text-slate-500 mt-1">Workspace isolated via RLS</div>
        </div>
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">HOT Leads</div>
          <div className="text-2xl font-bold text-[#149642] mt-1">{stats.hotLeads}</div>
          <div className="text-xs text-slate-500 mt-1">Confirmed need + next step</div>
        </div>
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">Callbacks Due</div>
          <div className="text-2xl font-bold text-[#0B1220] mt-1">{stats.openCallbacks}</div>
          <div className="text-xs text-slate-500 mt-1">1 task per qualified attempt</div>
        </div>
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-4">
          <div className="text-xs font-semibold uppercase text-slate-500">Sheet Sync Queue</div>
          <div className="text-2xl font-bold text-[#0B1220] mt-1">
            {stats.pendingSheetSyncs} pending / {stats.failedSheetSyncs} failed
          </div>
          <div className="text-xs text-slate-500 mt-1">Server-side outbox jobs</div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#0B1220]">Workspace Leads</h2>
            <Link href="/leads" className="text-xs font-semibold text-[#0F7633] hover:underline">
              Manage all &rarr;
            </Link>
          </div>
          {recentLeads.length === 0 ? (
            <p className="text-sm text-slate-600">
              No leads found. Run the founder bootstrap command to seed the synthetic test lead.
            </p>
          ) : (
            <div className="divide-y divide-[#E2E8E2]">
              {recentLeads.map((lead) => (
                <div key={lead.id} className="py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-sm text-[#0B1220]">
                        {lead.full_name}{' '}
                        <span className="text-xs font-mono text-slate-500">
                          ({lead.external_lead_id})
                        </span>
                      </div>
                      <div className="text-xs text-slate-600">
                        {lead.phone_e164} · {lead.service_interest}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F7F9F6] border border-[#E2E8E2]">
                        {lead.lead_temperature}
                      </span>
                      <form action={runMockOutboundCallAction}>
                        <input type="hidden" name="leadId" value={lead.id} />
                        <input type="hidden" name="scenario" value="HOT_CALLBACK" />
                        <button
                          type="submit"
                          className="px-2.5 py-1 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-xs font-semibold cursor-pointer"
                        >
                          Qualify HOT ({workspace.agent_name})
                        </button>
                      </form>
                    </div>
                  </div>
                  <LiveNilaCallButton
                    leadId={lead.id}
                    phoneE164={lead.phone_e164}
                    fullName={lead.full_name}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#0B1220]">Open Founder Callback Tasks</h2>
            <Link
              href="/follow-ups"
              className="text-xs font-semibold text-[#0F7633] hover:underline"
            >
              View all &rarr;
            </Link>
          </div>
          {openTasks.length === 0 ? (
            <p className="text-sm text-slate-600">
              No open callback tasks yet. Qualify a lead as HOT to create a founder callback task.
            </p>
          ) : (
            <div className="divide-y divide-[#E2E8E2]">
              {openTasks.map((task) => (
                <div key={task.id} className="py-3 space-y-1">
                  <div className="text-sm font-semibold text-[#0B1220]">{task.title}</div>
                  <div className="text-xs text-slate-600">
                    Due (UTC): <code className="font-mono">{task.due_at}</code> · Status:{' '}
                    <strong>{task.status}</strong>
                  </div>
                  {task.notes && <p className="text-xs text-slate-500">{task.notes}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

