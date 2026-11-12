# DigiAnchorZ Voice SaaS · Supabase CRM & Tanglish Voice Agent (Nila)

Multi-tenant Voice Qualification & Founder CRM built with **Next.js App Router**, **TypeScript**, **Tailwind CSS**, **Supabase Auth (`@supabase/ssr`)**, and **PostgreSQL Row-Level Security (RLS)**.

- **Workspace**: `DigiAnchorZ` (`slug: digianchorz`)
- **Voice Agent Name**: `Nila` (Tanglish NEPQ enquiry assistant)
- **Outbound Telephony Mode**: `mock` (Exotel + Sarvam speech mocked; Supabase Auth & Postgres CRM live)
- **Connected Google Sheet**: `1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A` ([Open Sheet](https://docs.google.com/spreadsheets/d/1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A/edit?usp=sharing))

---

## 1. Environment Variables

Copy `.env.example` to `.env.local` and fill in your Supabase project credentials:

```bash
cp .env.example .env.local
```

Key variables in `.env.example`:
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase publishable / anon key for `@supabase/ssr`
- `SUPABASE_SECRET_KEY` — Server-only secret key for founder bootstrap & background workers
- `DATABASE_URL` — PostgreSQL connection string for migrations
- `SUPABASE_AUTH_REDIRECT_URL=http://localhost:3000/auth/callback`
- `GOOGLE_SHEET_ID=1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A`
- `VOICE_AGENT_NAME=Nila`
- `APP_MODE=mock` / `TELEPHONY_PROVIDER_MODE=mock`

---

## 2. Versioned SQL Migrations (`supabase/migrations/`)

Apply the migrations in order via Supabase CLI (`supabase db push`) or the Supabase SQL Editor:

1. `supabase/migrations/20261112000100_workspaces_and_members.sql` — `workspaces`, `workspace_members`, and RLS membership functions (`public.is_workspace_member`, `public.has_workspace_role`).
2. `supabase/migrations/20261112000200_leads_and_call_attempts.sql` — `leads` and `call_attempts` with composite workspace foreign keys and workspace-member RLS policies.
3. `supabase/migrations/20261112000300_follow_up_tasks.sql` — `follow_up_tasks` with composite workspace foreign keys, per-attempt uniqueness (`unique (workspace_id, source_call_attempt_id)`), and RLS policies.
4. `supabase/migrations/20261112000400_lead_suppressions_and_sheet_sync_jobs.sql` — `lead_suppressions`, server-side `sheet_sync_jobs` outbox (read-only for authenticated members; writes restricted to server/service role), atomic outcome RPC `public.record_call_outcome_and_follow_up`, and founder bootstrap RPC `public.bootstrap_digianchorz_founder`.

---

## 3. Exact Supabase Auth Callback Route

- **Route**: `/auth/callback` (`GET /auth/callback`, implemented in `src/app/auth/callback/route.ts`)
- **Full Local URL**: `http://localhost:3000/auth/callback`
- Exchanges PKCE `code` (`supabase.auth.exchangeCodeForSession(code)`) or `token_hash` (`supabase.auth.verifyOtp`) and redirects to the protected CRM routes.

---

## 4. Documented Founder Bootstrap Step

Once you have created or invited the founder user in **Supabase Auth** (`Authentication -> Users`) and copied their User UUID:

### Option A: CLI Command
```bash
npm run bootstrap:founder -- <SUPABASE_AUTH_USER_ID> founder@digianchorz.com
```

### Option B: Supabase SQL Editor
```sql
select public.bootstrap_digianchorz_founder(
  '<SUPABASE_AUTH_USER_ID>'::uuid,
  'founder@digianchorz.com'
);
```

Both methods:
1. Create/update the **DigiAnchorZ** workspace (`slug: digianchorz`, agent `Nila`, Google Sheet `1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A`).
2. Assign the given Supabase Auth user ID as `owner` in `public.workspace_members`.
3. Seed the synthetic test lead `DAZ-SYNTH-LEAD-001` (`Karthik Subramanian`, `+919876543210`, `Meta Ads Enquiry Follow-up`).

---

## 5. Development & Verification Commands

```bash
npm install
npm run typecheck
npm test
npm run dev
```

