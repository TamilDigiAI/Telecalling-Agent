import { signInWithMagicLinkAction, signInWithPasswordAction } from '@/app/actions/crm';
import { getRuntimeEnv } from '@/lib/env';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const env = getRuntimeEnv();
  const errorMsg = typeof params.error === 'string' ? params.error : null;
  const magicLinkSent = params.magic_link === 'sent';
  const setupRequired = params.setup === 'required' || !env.isSupabaseConfigured;
  const nextPath = typeof params.next === 'string' ? params.next : '/';

  return (
    <main className="min-h-screen flex flex-col justify-center items-center px-4 py-12 bg-[#F7F9F6]">
      <div className="w-full max-w-md bg-white border border-[#E2E8E2] rounded-2xl shadow-sm p-8">
        <div className="flex flex-col items-center text-center mb-6">
          <img
            src="/brand/digianchorz-wordmark.png"
            alt="DigiAnchorZ"
            className="h-12 w-auto object-contain mb-3"
          />
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#FBB61B]/20 text-[#0B1220] border border-[#FBB61B]">
            Voice Agent: {env.voiceAgentName} · Outbound Telephony: {env.telephonyProviderMode.toUpperCase()}
          </span>
          <h1 className="text-xl font-bold text-[#0B1220] mt-4">
            Founder CRM Sign In
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Protected by Supabase Auth (@supabase/ssr) &amp; Workspace Row-Level Security
          </p>
        </div>

        {setupRequired && (
          <div className="mb-5 p-3.5 rounded-xl bg-amber-50 border border-[#FBB61B] text-xs text-[#0B1220] space-y-1">
            <p className="font-semibold">Supabase Credentials Required</p>
            <p>
              Copy <code className="font-mono bg-white px-1 py-0.5 rounded">.env.example</code> to{' '}
              <code className="font-mono bg-white px-1 py-0.5 rounded">.env.local</code> and set{' '}
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>.
            </p>
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900"
          >
            <span className="font-semibold">Sign-in error:</span> {errorMsg}
          </div>
        )}

        {magicLinkSent && (
          <div
            role="status"
            className="mb-5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950"
          >
            Magic link sent! Check your inbox. The link redirects through{' '}
            <code className="font-mono">/auth/callback</code>.
          </div>
        )}

        <form action={signInWithPasswordAction} className="space-y-4">
          <input type="hidden" name="next" value={nextPath} />
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1"
            >
              Founder Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              defaultValue={env.founderLoginEmail}
              placeholder="founder@digianchorz.com"
              className="w-full rounded-lg border border-[#E2E8E2] px-3.5 py-2.5 text-sm text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#149642]"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              placeholder="••••••••••••"
              className="w-full rounded-lg border border-[#E2E8E2] px-3.5 py-2.5 text-sm text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#149642]"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white font-semibold py-2.5 px-4 text-sm transition-colors cursor-pointer"
          >
            Sign In to DigiAnchorZ Workspace
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-[#E2E8E2]" />
          <span className="text-xs text-slate-500">or passwordless magic link</span>
          <div className="h-px flex-1 bg-[#E2E8E2]" />
        </div>

        <form action={signInWithMagicLinkAction} className="space-y-3">
          <input
            name="email"
            type="email"
            required
            defaultValue={env.founderLoginEmail}
            aria-label="Founder Email for Magic Link"
            className="w-full rounded-lg border border-[#E2E8E2] px-3.5 py-2 text-sm text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#149642]"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-[#FBB61B] hover:bg-[#f0aa0c] text-[#0B1220] font-semibold py-2.5 px-4 text-sm transition-colors cursor-pointer"
          >
            Send Magic Link via /auth/callback
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-[#E2E8E2] text-xs text-slate-600 space-y-1">
          <div>
            <span className="font-semibold text-[#0B1220]">Auth Callback Route:</span>{' '}
            <code className="font-mono">/auth/callback</code>
          </div>
          <div>
            <span className="font-semibold text-[#0B1220]">Founder Bootstrap Command:</span>{' '}
            <code className="font-mono break-all">
              npm run bootstrap:founder -- &lt;SUPABASE_AUTH_USER_ID&gt;
            </code>
          </div>
        </div>
      </div>
    </main>
  );
}

