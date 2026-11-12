import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { listWorkspaceLeads } from '@/lib/crm/service';
import { runMockOutboundCallAction, saveCallOutcomeAction } from '@/app/actions/crm';
import { LiveNilaCallButton } from '@/components/leads/LiveNilaCallButton';
import { GoogleSheetSyncButton } from '@/components/leads/GoogleSheetSyncButton';
import type { LeadTemperature } from '@/types/crm';

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q : undefined;
  const temperature =
    typeof params.temperature === 'string' &&
    ['HOT', 'WARM', 'COLD', 'UNQUALIFIED'].includes(params.temperature)
      ? (params.temperature as LeadTemperature)
      : undefined;

  const { supabase, workspace } = pageState.context;
  const leads = await listWorkspaceLeads(supabase, workspace.id, {
    search,
    temperature,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#0B1220]">Leads &amp; Voice Qualification</h1>
          <p className="text-sm text-slate-600">
            Mock Telephony with Agent <strong>{workspace.agent_name}</strong> · Connected Sheet:{' '}
            <a
              href={workspace.google_sheet_url}
              target="_blank"
              rel="noreferrer"
              className="text-[#0F7633] underline font-mono text-xs"
            >
              {workspace.google_sheet_id}
            </a>
          </p>
        </div>
        <GoogleSheetSyncButton sheetId={workspace.google_sheet_id} />
      </div>

      <form method="get" className="bg-white border border-[#E2E8E2] rounded-xl p-4 flex flex-wrap gap-3">
        <input
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search name, phone (+91...), or Lead ID..."
          className="flex-1 min-w-[220px] rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
        />
        <select
          name="temperature"
          defaultValue={temperature ?? ''}
          aria-label="Filter by Lead Temperature"
          className="rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm bg-white"
        >
          <option value="">All Temperatures</option>
          <option value="HOT">HOT</option>
          <option value="WARM">WARM</option>
          <option value="COLD">COLD</option>
          <option value="UNQUALIFIED">UNQUALIFIED</option>
        </select>
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-[#0B1220] text-white text-sm font-semibold cursor-pointer"
        >
          Filter
        </button>
      </form>

      <div className="space-y-4">
        {leads.map((lead) => (
          <article
            key={lead.id}
            className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4"
          >
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-bold text-[#0B1220]">{lead.full_name}</h2>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-mono bg-[#F7F9F6] border border-[#E2E8E2]">
                    {lead.external_lead_id}
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#149642]/15 text-[#0F7633]">
                    Temperature: {lead.lead_temperature}
                  </span>
                  {lead.latest_call_outcome && (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FBB61B]/25 text-[#0B1220]">
                      Outcome: {lead.latest_call_outcome}
                    </span>
                  )}
                  {lead.do_not_call && (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-900">
                      DO NOT CALL (Suppressed)
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  Phone: <strong className="font-mono">{lead.phone_e164}</strong> (raw:{' '}
                  <code className="font-mono">{lead.raw_phone}</code>) · Service:{' '}
                  <strong>{lead.service_interest}</strong> · Eligibility:{' '}
                  <code className="font-mono">{lead.eligibility_reference}</code>
                </div>
              </div>

              <div className="text-xs text-slate-600 md:text-right">
                <div>Attempts: <strong>{lead.attempts_count}</strong></div>
                <div>Sheet Sync: <strong>{lead.sync_status}</strong></div>
                {lead.callback_at && (
                  <div>
                    Agreed Callback: <code className="font-mono">{lead.callback_at}</code>
                  </div>
                )}
              </div>
            </div>

            {lead.call_summary && (
              <div className="p-3 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] text-xs space-y-1">
                <div className="font-semibold text-[#0B1220]">
                  Latest Qualification Summary ({workspace.agent_name}):
                </div>
                <p className="text-slate-700">{lead.call_summary}</p>
                {lead.qualification_reason && (
                  <p className="text-slate-500">Reason: {lead.qualification_reason}</p>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-[#E2E8E2] flex flex-wrap items-center gap-2">
              <form action={saveCallOutcomeAction}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="callOutcome" value="CALLBACK_REQUESTED" />
                <input type="hidden" name="proposedTemperature" value="HOT" />
                <input
                  type="hidden"
                  name="qualificationReason"
                  value="Active Meta Ads requirement with confirmed founder callback tomorrow at 11:00 AM IST."
                />
                <input
                  type="hidden"
                  name="summary"
                  value={`Agent ${workspace.agent_name} qualified ${lead.full_name} as HOT and scheduled 1 founder callback task.`}
                />
                <button
                  type="submit"
                  className="px-3.5 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-xs font-semibold cursor-pointer"
                >
                  Save HOT Call Outcome + Create 1 Callback Task
                </button>
              </form>

              <form action={runMockOutboundCallAction}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="scenario" value="WARM_INTEREST" />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg bg-[#FBB61B] text-[#0B1220] text-xs font-semibold cursor-pointer"
                >
                  Simulate WARM Call
                </button>
              </form>

              <form action={runMockOutboundCallAction}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="scenario" value="NO_ANSWER" />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg border border-[#E2E8E2] bg-white text-[#0B1220] text-xs font-semibold cursor-pointer"
                >
                  Simulate NO_ANSWER
                </button>
              </form>

              <form action={runMockOutboundCallAction}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="scenario" value="PRICING_NO_APPROVED_RATE" />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg border border-[#149642] bg-[#149642]/10 text-[#0F7633] text-xs font-semibold cursor-pointer"
                >
                  Simulate Pricing Question (No Approved Rate)
                </button>
              </form>

              <form action={runMockOutboundCallAction}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="scenario" value="OPT_OUT_DNC" />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-red-900 text-xs font-semibold cursor-pointer"
                >
                  Simulate Opt-Out (DNC)
                </button>
              </form>
            </div>

            <LiveNilaCallButton
              leadId={lead.id}
              phoneE164={lead.phone_e164}
              fullName={lead.full_name}
            />
          </article>
        ))}
      </div>
    </div>
  );
}

