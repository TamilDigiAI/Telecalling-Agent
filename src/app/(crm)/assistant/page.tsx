import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { generateFounderTanglishBriefing, listWorkspaceLeads } from '@/lib/crm/service';
import { createManualFollowUpTaskAction } from '@/app/actions/crm';
import { FounderAssistantPanel } from '@/components/assistant/FounderAssistantPanel';

export default async function FounderAssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const params = await searchParams;
  const preselectedLeadId = typeof params.leadId === 'string' ? params.leadId : undefined;

  const { supabase, workspace } = pageState.context;
  const [briefing, leads] = await Promise.all([
    generateFounderTanglishBriefing(supabase, workspace.id, workspace.agent_name),
    listWorkspaceLeads(supabase, workspace.id),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[#0B1220]">Nila Assistant</h1>

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-bold text-[#0F7633]">Daily Briefing</h2>
        <p className="text-sm text-[#0B1220]">{briefing.tanglishText}</p>
      </section>

      <FounderAssistantPanel />

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
        <h2 className="text-base font-bold text-[#0B1220]">Schedule Follow-up Task</h2>

        <form action={createManualFollowUpTaskAction} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="leadId"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Lead
            </label>
            <select
              id="leadId"
              name="leadId"
              required
              defaultValue={preselectedLeadId ?? leads[0]?.id ?? ''}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm bg-white"
            >
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.full_name} ({lead.phone_e164})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="title"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Title
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              placeholder="e.g. Founder callback on Meta Ads quote"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="notes"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Notes
            </label>
            <input
              id="notes"
              name="notes"
              type="text"
              placeholder="Optional callback notes or preferred IST slot"
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2 flex items-center gap-2">
            <input
              id="confirmed"
              name="confirmed"
              type="checkbox"
              value="true"
              required
              className="h-4 w-4 rounded border-[#E2E8E2] text-[#149642]"
            />
            <label htmlFor="confirmed" className="text-xs font-medium text-[#0B1220]">
              Confirm saving this follow-up task
            </label>
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-sm font-semibold cursor-pointer"
            >
              Save Follow-up Task
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
