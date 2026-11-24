import Link from 'next/link';
import { getProtectedPageContext } from '@/lib/auth/workspace-guard';
import { signOutAction } from '@/app/actions/crm';

const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/leads', label: 'Leads' },
  { href: '/follow-ups', label: 'Follow-ups' },
  { href: '/assistant', label: 'Nila Assistant' },
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
          <img
            src="/brand/digianchorz-wordmark.png"
            alt="DigiAnchorZ"
            className="h-9 w-auto object-contain"
          />
          <h1 className="text-lg font-bold text-[#0B1220]">
            Account Not Assigned to DigiAnchorZ Workspace
          </h1>
          <p className="text-sm text-slate-600">
            Signed in as <span className="font-semibold text-[#0B1220]">{pageState.user.email}</span>.
            Ask the workspace owner to grant access before viewing CRM records.
          </p>
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

  const { workspace, user } = pageState.context;

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#F7F9F6] text-[#0B1220]">
      <aside className="w-full md:w-60 bg-white border-b md:border-b-0 md:border-r border-[#E2E8E2] flex flex-col justify-between shrink-0">
        <div className="p-4 md:p-5">
          <div className="flex items-center justify-between md:justify-start gap-3 mb-4 md:mb-6">
            <Link href="/" className="flex items-center gap-2">
              <img
                src="/brand/digianchorz-wordmark.png"
                alt="DigiAnchorZ"
                className="h-8 w-auto object-contain hidden md:block"
              />
              <img
                src="/brand/digianchorz-symbol.png"
                alt="DigiAnchorZ"
                className="h-8 w-8 object-contain md:hidden"
              />
            </Link>
            {workspace.dial_paused && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200">
                Calling Paused
              </span>
            )}
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

        <div className="hidden md:block p-4 border-t border-[#E2E8E2] text-xs space-y-2">
          <div className="truncate text-slate-600" title={user.email ?? user.id}>
            {user.email ?? 'Founder'}
          </div>
          <form action="/api/auth/logout" method="POST">
            <button
              type="submit"
              className="w-full text-left px-3 py-1.5 rounded-lg border border-[#E2E8E2] text-xs font-semibold text-[#0B1220] hover:bg-slate-50 cursor-pointer"
            >
              Sign Out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 p-4 sm:p-6 md:p-8 max-w-6xl w-full mx-auto">{children}</main>
    </div>
  );
}
