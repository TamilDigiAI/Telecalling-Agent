import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { resolveBusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';
import { BusinessSettingsForm } from '@/components/settings/BusinessSettingsForm';

export default async function OwnerBusinessSettingsPage() {
  const pageState = await getProtectedPageContext();
  if (pageState.status !== 'ready') return null;

  const { workspace, membership } = pageState.context;
  const businessSettings = resolveBusinessKnowledgeSettings(workspace.business_profile);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0B1220]">
          Business Settings · Nila Knowledge &amp; Sales Qualification Rules
        </h1>
        <p className="text-sm text-slate-600">
          Owner-only configuration for <strong>{businessSettings.business_name}</strong> (Founder:{' '}
          <strong>{businessSettings.founder_name}</strong> · {businessSettings.location}). Shared by
          both the outbound sales agent and the founder assistant.
        </p>
      </div>

      <BusinessSettingsForm
        settings={businessSettings}
        isOwner={membership.role === 'owner'}
      />
    </div>
  );
}

