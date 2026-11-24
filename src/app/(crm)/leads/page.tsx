import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { listWorkspaceLeads } from '@/lib/crm/service';
import { GoogleSheetSyncButton } from '@/components/leads/GoogleSheetSyncButton';
import { CallWithNilaButton } from '@/components/leads/CallWithNilaButton';
import { isPilotTestContact } from '@/lib/pilot/test-contacts';
import type { LeadTemperature } from '@/types/crm';

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

function statusPillClass(temp: LeadTemperature, doNotCall: boolean): string {
  if (doNotCall) return 'bg-red-100 text-red-900';
  switch (temp) {
    case 'HOT':
      return 'bg-[#149642]/15 text-[#0F7633]';
    case 'WARM':
      return 'bg-[#FBB61B]/25 text-[#0B1220]';
    case 'COLD':
      return 'bg-slate-200 text-slate-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

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
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl font-bold text-[#0B1220]">Leads</h1>
        <GoogleSheetSyncButton sheetId={workspace.google_sheet_id} />
      </div>

      <form
        method="get"
        className="bg-white border border-[#E2E8E2] rounded-xl p-3 flex flex-wrap gap-2.5"
      >
        <input
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search name, phone, or Lead ID..."
          className="flex-1 min-w-[200px] rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
        />
        <select
          name="temperature"
          defaultValue={temperature ?? ''}
          aria-label="Filter by Lead status"
          className="rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm bg-white"
        >
          <option value="">All Statuses</option>
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

      {leads.length === 0 ? (
        <div className="bg-white border border-[#E2E8E2] rounded-xl p-8 text-center text-sm text-slate-600">
          No leads found. Click <strong>Sync Test Leads</strong> to import contacts from Google
          Sheets.
        </div>
      ) : (
        <div className="bg-white border border-[#E2E8E2] rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-[#E2E8E2] bg-[#F7F9F6] text-xs uppercase text-slate-600">
                <th className="py-3 px-4 font-semibold">Name</th>
                <th className="py-3 px-4 font-semibold">Phone</th>
                <th className="py-3 px-4 font-semibold hidden md:table-cell">Service</th>
                <th className="py-3 px-4 font-semibold">Lead status</th>
                <th className="py-3 px-4 font-semibold hidden sm:table-cell">Next follow-up</th>
                <th className="py-3 px-4 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8E2]">
              {leads.map((lead) => (
                <tr key={lead.id} className="hover:bg-[#F7F9F6]/70 transition-colors">
                  <td className="py-3.5 px-4">
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-semibold text-[#0B1220] hover:text-[#149642] block"
                    >
                      {lead.full_name}
                    </Link>
                    {isPilotTestContact(lead.external_lead_id) && (
                      <span className="inline-block mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800 bg-indigo-50 px-1.5 py-0.5 rounded">
                        Test Contact
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                    <Link href={`/leads/${lead.id}`} className="hover:underline">
                      {lead.phone_e164}
                    </Link>
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-600 hidden md:table-cell max-w-[220px] truncate">
                    {lead.service_interest}
                  </td>
                  <td className="py-3.5 px-4 whitespace-nowrap">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusPillClass(
                        lead.lead_temperature,
                        lead.do_not_call
                      )}`}
                    >
                      {lead.do_not_call ? 'Do Not Call' : lead.lead_temperature}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-xs text-slate-600 hidden sm:table-cell whitespace-nowrap">
                    {formatIst(lead.callback_at)}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex items-start justify-end gap-2">
                      <CallWithNilaButton
                        leadId={lead.id}
                        phoneE164={lead.phone_e164}
                        eligible={lead.calling_eligibility === 'ELIGIBLE'}
                        doNotCall={lead.do_not_call}
                        compact
                      />
                      <details className="relative">
                        <summary
                          aria-label={`More actions for ${lead.full_name}`}
                          className="list-none px-2.5 py-1.5 rounded-lg border border-[#E2E8E2] bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer select-none"
                        >
                          More
                        </summary>
                        <div className="absolute right-0 mt-1 w-40 bg-white border border-[#E2E8E2] rounded-lg shadow-md py-1 z-20 text-xs">
                          <Link
                            href={`/leads/${lead.id}`}
                            className="block px-3 py-2 text-[#0B1220] hover:bg-[#F7F9F6]"
                          >
                            View Lead Details
                          </Link>
                          <Link
                            href={`/assistant?leadId=${lead.id}`}
                            className="block px-3 py-2 text-[#0B1220] hover:bg-[#F7F9F6]"
                          >
                            Schedule Follow-up
                          </Link>
                        </div>
                      </details>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
