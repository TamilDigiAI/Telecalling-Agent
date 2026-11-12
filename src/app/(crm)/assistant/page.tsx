import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { getRuntimeEnv } from '@/lib/env';
import { generateFounderTanglishBriefing, listWorkspaceLeads } from '@/lib/crm/service';
import { createManualFollowUpTaskAction } from '@/app/actions/crm';
import { NilaVoiceTestPanel } from '@/components/assistant/NilaVoiceTestPanel';

export default async function FounderAssistantPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const env = getRuntimeEnv();
  const { supabase, workspace } = pageState.context;
  const [briefing, leads] = await Promise.all([
    generateFounderTanglishBriefing(supabase, workspace.id, workspace.agent_name),
    listWorkspaceLeads(supabase, workspace.id),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0B1220]">
          Founder Assistant · Voice Agent {workspace.agent_name}
        </h1>
        <p className="text-sm text-slate-600">
          Private Nila Voice Test (Sarvam Saaras + Sarvam 105B + Bulbul v3) &amp; Workspace Briefing
          for <strong>{workspace.name}</strong>.
        </p>
      </div>

      {/* Private Browser Nila Voice Test Screen (Does not create CRM tasks; Exotel & Sheets disabled) */}
      <NilaVoiceTestPanel
        sttModel={env.sarvamSttModel}
        sttMode={env.sarvamSttMode}
        ttsModel={env.sarvamTtsModel}
        ttsSpeaker={env.sarvamTtsSpeaker}
        ttsLanguage={env.sarvamTtsLanguage}
        llmModel={env.llmModel}
      />

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[#0F7633]">
            Live Tanglish CRM Briefing ({workspace.agent_name})
          </span>
          <span className="text-xs text-slate-500">Prompt: &ldquo;Innaiku hot leads yaaru?&rdquo;</span>
        </div>
        <blockquote className="p-4 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] text-sm font-medium text-[#0B1220]">
          &ldquo;{briefing.tanglishText}&rdquo;
        </blockquote>
      </section>

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
        <h2 className="text-base font-bold text-[#0B1220]">
          Confirm &amp; Schedule Founder Callback Task
        </h2>
        <p className="text-xs text-slate-600">
          Explicit confirmation in the current authenticated session creates or updates one idempotent
          callback task.
        </p>

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
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm bg-white"
            >
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.full_name} ({lead.phone_e164}) — {lead.lead_temperature}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="title"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Callback Action Title
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              defaultValue={`Founder callback confirmed via Assistant ${workspace.agent_name}`}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="notes"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Tanglish Read-Back / Notes
            </label>
            <input
              id="notes"
              name="notes"
              type="text"
              defaultValue="Naalaikku kaalaila 11:00 AM IST founder callback confirm panniyachu."
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              className="px-4 py-2.5 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-sm font-semibold cursor-pointer"
            >
              Confirm &amp; Create Follow-Up Task
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
