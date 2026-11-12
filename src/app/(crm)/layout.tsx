import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { signOutAction } from '@/app/actions/crm';

const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/leads', label: 'Leads' },
  { href: '/calls', label: 'Calls' },
  { href: '/follow-ups', label: 'Follow-ups' },
  { href: '/assistant', label: 'Founder Assistant' },
  { href: '/settings/business', label: 'Business Settings' },
  { href: '/settings', label: 'Settings' },
];

export default async function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pageState = await getProtectedPageContext();

  if (pageState.status === 'unbootstrapped') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#F7F9F6]">
        <div className="max-w-lg w-full bg-white border border-[#E2E8E2] rounded-2xl p-8 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <img
              src="/brand/digianchorz-wordmark.png"
              alt="DigiAnchorZ"
              className="h-9 w-auto object-contain"
            />
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-900 border border-red-200">
              Workspace Access Denied (RLS Active)
            </span>
          </div>
          <h1 className="text-lg font-bold text-[#0B1220]">
            Account Not Assigned to DigiAnchorZ Workspace
          </h1>
          <p className="text-sm text-slate-600">
            Signed in as <span className="font-semibold text-[#0B1220]">{pageState.user.email}</span>{' '}
            (<code className="font-mono text-xs">{pageState.user.id}</code>). Because Row-Level
            Security restricts CRM tables to authenticated workspace members, this user cannot read
            any leads, calls, or follow-up tasks.
          </p>
          <div className="p-3.5 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] text-xs space-y-1.5">
            <div className="font-semibold text-[#0B1220]">
              If this is the Founder account, run the bootstrap command:
            </div>
            <pre className="font-mono bg-white p-2.5 rounded border border-[#E2E8E2] overflow-x-auto">
              npm run bootstrap:founder -- {pageState.user.id} {pageState.user.email ?? ''}
            </pre>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg border border-[#E2E8E2] text-sm font-medium hover:bg-slate-50 cursor-pointer"
            >
              Sign Out
            </button>
          </form>
        </div>
      </div>
    );
  }

  const { workspace, membership, user } = pageState.context;

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#F7F9F6] text-[#0B1220]">
      <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-[#E2E8E2] flex flex-col justify-between shrink-0">
        <div className="p-5">
          <div className="flex items-center gap-3 mb-6">
            <img
              src="/brand/digianchorz-wordmark.png"
              alt="DigiAnchorZ"
              className="h-9 w-auto object-contain hidden md:block"
            />
            <img
              src="/brand/digianchorz-symbol.png"
              alt="DigiAnchorZ Symbol"
              className="h-8 w-8 object-contain md:hidden"
            />
          </div>

          <div className="mb-5 p-3 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[#0B1220]">{workspace.name}</span>
              <span className="px-2 py-0.5 rounded bg-[#149642]/15 text-[#0F7633] font-semibold uppercase">
                {membership.role}
              </span>
            </div>
            <div className="text-slate-600">
              Voice Agent: <strong className="text-[#0B1220]">{workspace.agent_name}</strong>
            </div>
            <div className="text-slate-600">
              Telephony: <strong className="text-[#0B1220]">{workspace.telephony_mode.toUpperCase()}</strong>
            </div>
          </div>

          <nav aria-label="Main CRM Navigation" className="flex md:flex-col gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3.5 py-2.5 rounded-lg text-sm font-medium text-[#0B1220] hover:bg-[#149642]/10 focus:outline-none focus:ring-2 focus:ring-[#149642] whitespace-nowrap"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t border-[#E2E8E2] text-xs space-y-2">
          <div className="truncate text-slate-600" title={user.email ?? user.id}>
            Founder: <span className="font-medium text-[#0B1220]">{user.email ?? user.id}</span>
          </div>
          <div className="text-slate-500">Timezone: {workspace.timezone}</div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full text-left px-3 py-1.5 rounded-lg border border-[#E2E8E2] text-xs font-semibold text-[#0B1220] hover:bg-slate-50 cursor-pointer"
            >
              Sign Out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 p-6 md:p-8 max-w-6xl w-full mx-auto">{children}</main>
    </div>
  );
}

