import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { getRuntimeEnv } from '@/lib/env';
import { resolveBusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';
import { BusinessSettingsForm } from '@/components/settings/BusinessSettingsForm';
import {
  listWorkspaceSheetSyncJobs,
  listWorkspaceSuppressions,
} from '@/lib/crm/service';
import {
  processPendingSheetSyncJobsServerAction,
  updateWorkspaceControlsAction,
} from '@/app/actions/crm';

export default async function SettingsPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { supabase, workspace, membership } = pageState.context;
  const env = getRuntimeEnv();
  const businessSettings = resolveBusinessKnowledgeSettings(workspace.business_profile);
  const [syncJobs, suppressions] = await Promise.all([
    listWorkspaceSheetSyncJobs(supabase, workspace.id),
    listWorkspaceSuppressions(supabase, workspace.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#0B1220]">Workspace Settings &amp; Integrations</h1>
          <p className="text-sm text-slate-600">
            Workspace: <strong>{workspace.name}</strong> (<code className="font-mono">{workspace.slug}</code>) ·
            Voice Agent: <strong>{workspace.agent_name}</strong> · Founder:{' '}
            <strong>{businessSettings.founder_name}</strong>
          </p>
        </div>
        <Link
          href="/settings/business"
          className="px-4 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-xs font-semibold"
        >
          Open Dedicated Business Settings Page &rarr;
        </Link>
      </div>

      <BusinessSettingsForm
        settings={businessSettings}
        isOwner={membership.role === 'owner'}
      />

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3 text-sm">
        <h2 className="text-base font-bold text-[#0B1220]">Integration Health &amp; Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2]">
            <div className="font-semibold text-[#0B1220]">Supabase Auth &amp; Postgres CRM</div>
            <div className="text-[#0F7633] font-semibold mt-0.5">
              LIVE (@supabase/ssr + RLS Enabled)
            </div>
          </div>
          <div className="p-3 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2]">
            <div className="font-semibold text-[#0B1220]">Outbound Telephony (Exotel / Twilio + Sarvam)</div>
            <div className="text-slate-700 font-semibold mt-0.5">
              MOCK MODE (Voice Agent: {workspace.agent_name}) · Exotel:{' '}
              {env.isExotelCredentialsConfigured ? 'Provisioned (Redacted)' : 'Not Set'} · Twilio:{' '}
              {env.isTwilioCredentialsConfigured ? 'Provisioned (Redacted)' : 'Not Set'}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] md:col-span-2">
            <div className="font-semibold text-[#0B1220]">Connected Google Sheet</div>
            <div className="mt-0.5 break-all">
              ID: <code className="font-mono">{workspace.google_sheet_id}</code> · Tab:{' '}
              <code className="font-mono">{workspace.google_sheet_tab}</code>
            </div>
            <div className="mt-1">
              <a
                href={workspace.google_sheet_url}
                target="_blank"
                rel="noreferrer"
                className="text-[#0F7633] underline"
              >
                {workspace.google_sheet_url}
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
        <h2 className="text-base font-bold text-[#0B1220]">Dialing Safety &amp; Pause Controls</h2>
        <form action={updateWorkspaceControlsAction} className="flex flex-wrap items-end gap-4">
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
              className="w-28 rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="dialPaused"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Dial Pause Switch
            </label>
            <select
              id="dialPaused"
              name="dialPaused"
              defaultValue={workspace.dial_paused ? 'true' : 'false'}
              className="rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm bg-white"
            >
              <option value="false">Active (Allowed Hours {workspace.allowed_start_hour_ist}:00–{workspace.allowed_end_hour_ist}:00 IST)</option>
              <option value="true">Paused</option>
            </select>
          </div>

          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-sm font-semibold cursor-pointer"
          >
            Save Controls
          </button>
        </form>
      </section>

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-[#0B1220]">
              Server-Side Google Sheet Sync Jobs ({syncJobs.length})
            </h2>
            <p className="text-xs text-slate-500">
              Authenticated members have read-only access; writes are restricted to server-side workers.
            </p>
          </div>
          <form action={processPendingSheetSyncJobsServerAction}>
            <button
              type="submit"
              className="px-3.5 py-2 rounded-lg bg-[#FBB61B] text-[#0B1220] text-xs font-semibold cursor-pointer"
            >
              Run Server-Side Sheet Sync Worker (Mock)
            </button>
          </form>
        </div>
        {syncJobs.slice(0, 8).map((job) => (
          <div
            key={job.id}
            className="p-3 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] text-xs flex items-center justify-between"
          >
            <div>
              <span className="font-semibold text-[#0B1220]">{job.operation}</span> · Key:{' '}
              <code className="font-mono">{job.idempotency_key}</code>
            </div>
            <span className="font-semibold">{job.status}</span>
          </div>
        ))}
      </section>

      <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-3">
        <h2 className="text-base font-bold text-[#0B1220]">
          Do-Not-Call Suppressions ({suppressions.length})
        </h2>
        {suppressions.map((sup) => (
          <div
            key={sup.id}
            className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs flex items-center justify-between text-red-950"
          >
            <div>
              <strong className="font-mono">{sup.phone_e164}</strong> · {sup.reason}
            </div>
            <span>{sup.active ? 'ACTIVE' : 'INACTIVE'}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

