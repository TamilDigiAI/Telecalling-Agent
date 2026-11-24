import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { getRuntimeEnv } from '@/lib/env';
import { getIntegrationHealthSummary } from '@/lib/integrations/health';
import { resolveBusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';
import { BusinessSettingsForm } from '@/components/settings/BusinessSettingsForm';
import { DeveloperToolsSection } from '@/components/settings/DeveloperToolsSection';
import {
  listWorkspaceIntegrationErrors,
  listWorkspaceLeads,
  listWorkspaceSheetSyncJobs,
  listWorkspaceSuppressions,
} from '@/lib/crm/service';
import {
  resolveIntegrationErrorAction,
  retryFailedSheetSyncJobAction,
  updateWorkspaceControlsAction,
} from '@/app/actions/crm';

function plainLanguageStatus(status: string): { label: string; className: string } {
  switch (status) {
    case 'Connected':
      return {
        label: 'Connected',
        className: 'bg-[#149642]/15 text-[#0F7633] border-[#149642]/30',
      };
    case 'Configured (Unverified)':
      return {
        label: 'Needs verification',
        className: 'bg-[#FBB61B]/25 text-[#0B1220] border-[#FBB61B]',
      };
    case 'Local Fallback (Mock)':
      return {
        label: 'Local mode',
        className: 'bg-sky-50 text-sky-900 border-sky-200',
      };
    case 'Error':
      return {
        label: 'Action required',
        className: 'bg-red-100 text-red-900 border-red-200',
      };
    default:
      return {
        label: 'Not connected',
        className: 'bg-slate-100 text-slate-700 border-slate-200',
      };
  }
}

export default async function SettingsPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace, membership } = pageState.context;
  const env = getRuntimeEnv();
  const businessSettings = resolveBusinessKnowledgeSettings(workspace.business_profile);
  const { items: integrationItems, vobizUrls } = getIntegrationHealthSummary();

  const [leads, syncJobs, suppressions, integrationErrors] = await Promise.all([
    listWorkspaceLeads(supabase, workspace.id),
    listWorkspaceSheetSyncJobs(supabase, workspace.id),
    listWorkspaceSuppressions(supabase, workspace.id),
    listWorkspaceIntegrationErrors(supabase, workspace.id),
  ]);

  const failedSyncs = syncJobs.filter((j) => j.status === 'FAILED' || j.status === 'DEAD_LETTER');
  const openErrors = integrationErrors.filter((e) => !e.resolved);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl font-bold text-[#0B1220]">Settings</h1>
        <Link
          href="/settings/business"
          className="px-4 py-2 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-xs font-semibold w-fit"
        >
          Edit Business Knowledge &rarr;
        </Link>
      </div>

      {/* 1. Integrations (Plain language; troubleshooting revealed on selection) */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
        <h2 className="text-base font-bold text-[#0B1220]">Integrations</h2>
        <div className="divide-y divide-[#E2E8E2]">
          {integrationItems.map((item) => {
            const badge = plainLanguageStatus(item.status);
            const hasIssue = item.status !== 'Connected';
            return (
              <details key={item.id} className="py-3 text-sm group">
                <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                  <span className="font-semibold text-[#0B1220]">{item.name}</span>
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </summary>
                <div className="mt-2.5 pl-1 text-xs text-slate-600 space-y-1">
                  <div>{item.detail}</div>
                  {hasIssue && item.missingVars.length > 0 && (
                    <div className="text-amber-800 font-mono">
                      Missing server configuration: {item.missingVars.join(', ')}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>

        {/* Failed Syncs & Integration Errors Troubleshooting */}
        {(failedSyncs.length > 0 || openErrors.length > 0) && (
          <div className="pt-3 border-t border-[#E2E8E2] space-y-2">
            <h3 className="text-xs font-bold uppercase text-red-800">
              Troubleshooting ({failedSyncs.length + openErrors.length})
            </h3>
            {failedSyncs.map((job) => (
              <details
                key={job.id}
                className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs"
              >
                <summary className="flex items-center justify-between gap-2 cursor-pointer font-semibold text-red-950">
                  <span>Google Sheet write failed ({job.status})</span>
                  <form action={retryFailedSheetSyncJobAction}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <button
                      type="submit"
                      className="px-2.5 py-1 rounded bg-[#149642] text-white font-semibold cursor-pointer"
                    >
                      Retry Sync
                    </button>
                  </form>
                </summary>
                <div className="mt-2 font-mono text-[11px] text-red-900">
                  {job.last_error || 'Unknown sync error'} · Attempts: {job.attempts}/
                  {job.max_attempts}
                </div>
              </details>
            ))}
            {openErrors.map((err) => (
              <details
                key={err.id}
                className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs"
              >
                <summary className="flex items-center justify-between gap-2 cursor-pointer font-semibold text-red-950">
                  <span>
                    {err.workflow_name || err.source}: {err.node_name || 'Error'}
                  </span>
                  <form action={resolveIntegrationErrorAction}>
                    <input type="hidden" name="errorId" value={err.id} />
                    <button
                      type="submit"
                      className="px-2.5 py-1 rounded bg-white border border-red-300 text-red-900 font-semibold cursor-pointer"
                    >
                      Resolve
                    </button>
                  </form>
                </summary>
                <div className="mt-2 text-red-900">{err.sanitized_message}</div>
              </details>
            ))}
          </div>
        )}
      </section>

      {/* 2. Calling Hours, Pilot Controls & Calling Pause Switch */}
      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
        <h2 className="text-base font-bold text-[#0B1220]">Calling Controls &amp; Pilot Allowlist</h2>

        <form action={updateWorkspaceControlsAction} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label
              htmlFor="dialPaused"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Calling Pause Switch
            </label>
            <select
              id="dialPaused"
              name="dialPaused"
              defaultValue={workspace.dial_paused ? 'true' : 'false'}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm bg-white"
            >
              <option value="false">Active</option>
              <option value="true">Paused</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="allowedStartHourIst"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Start Hour (IST)
            </label>
            <input
              id="allowedStartHourIst"
              name="allowedStartHourIst"
              type="number"
              min={0}
              max={22}
              defaultValue={workspace.allowed_start_hour_ist ?? 9}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="allowedEndHourIst"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              End Hour (IST)
            </label>
            <input
              id="allowedEndHourIst"
              name="allowedEndHourIst"
              type="number"
              min={1}
              max={23}
              defaultValue={workspace.allowed_end_hour_ist ?? 20}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="attemptCap"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Attempt Cap
            </label>
            <input
              id="attemptCap"
              name="attemptCap"
              type="number"
              min={1}
              max={10}
              defaultValue={workspace.attempt_cap}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div className="sm:col-span-2 md:col-span-4">
            <label
              htmlFor="allowlistPhones"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Pilot Allowlist Numbers
            </label>
            <textarea
              id="allowlistPhones"
              name="allowlistPhones"
              rows={2}
              defaultValue={(workspace.allowlist_phones ?? []).join(', ')}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-xs font-mono"
            />
          </div>

          <div className="sm:col-span-2 md:col-span-4">
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-sm font-semibold cursor-pointer"
            >
              Save Calling Controls
            </button>
          </div>
        </form>
      </section>

      {/* 3. Do-Not-Call Suppressions (only if any exist) */}
      {suppressions.length > 0 && (
        <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-2">
          <h2 className="text-base font-bold text-[#0B1220]">
            Do-Not-Call List ({suppressions.length})
          </h2>
          {suppressions.map((sup) => (
            <div
              key={sup.id}
              className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs flex items-center justify-between text-red-950"
            >
              <span className="font-mono font-semibold">{sup.phone_e164}</span>
              <span>{sup.reason}</span>
            </div>
          ))}
        </section>
      )}

      {/* 4. Business Knowledge */}
      <BusinessSettingsForm
        settings={businessSettings}
        isOwner={membership.role === 'owner'}
      />

      {/* 5. Developer Tools (Hidden until enabled) */}
      <DeveloperToolsSection
        leads={leads}
        sttModel={env.sarvamSttModel}
        sttMode={env.sarvamSttMode}
        ttsModel={env.sarvamTtsModel}
        ttsSpeaker={env.sarvamTtsSpeaker}
        ttsLanguage={env.sarvamTtsLanguage}
        llmModel={env.llmModel}
        vobizUrls={vobizUrls}
      />
    </div>
  );
}
