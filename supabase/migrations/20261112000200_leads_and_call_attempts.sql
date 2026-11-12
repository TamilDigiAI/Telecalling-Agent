-- =============================================================================
-- Migration 02: Leads and Call Attempts
-- DigiAnchorZ Voice SaaS · Tenant-isolated Lead & Telephony Attempt Storage
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: public.leads
-- -----------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  external_lead_id text not null,
  sheet_id text not null default '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
  sheet_tab text not null default 'Leads',
  sheet_row_number integer,
  full_name text not null,
  raw_phone text not null,
  phone_e164 text not null,
  service_interest text not null,
  source text not null default 'Google Sheet',
  calling_eligibility text not null default 'ELIGIBLE' check (
    calling_eligibility in ('ELIGIBLE', 'INELIGIBLE', 'PENDING_REVIEW')
  ),
  eligibility_reference text not null,
  available_window text not null default '09:00-20:00 IST',
  do_not_call boolean not null default false,
  lead_temperature text not null default 'UNQUALIFIED' check (
    lead_temperature in ('HOT', 'WARM', 'COLD', 'UNQUALIFIED')
  ),
  latest_call_outcome text check (
    latest_call_outcome is null or latest_call_outcome in (
      'CONNECTED',
      'CALLBACK_REQUESTED',
      'NO_ANSWER',
      'BUSY',
      'FAILED',
      'VOICEMAIL',
      'WRONG_NUMBER',
      'DO_NOT_CALL'
    )
  ),
  qualification_reason text,
  call_summary text,
  need_summary text,
  timeline text,
  budget_band text,
  next_action text,
  callback_at timestamptz,
  last_call_at timestamptz,
  attempts_count integer not null default 0 check (attempts_count >= 0),
  owner_user_id uuid references auth.users(id) on delete set null,
  sync_status text not null default 'PENDING' check (
    sync_status in ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED')
  ),
  last_synced_at timestamptz,
  sync_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint leads_id_workspace_unique unique (id, workspace_id),
  constraint leads_workspace_external_id_unique unique (workspace_id, external_lead_id)
);

create index if not exists idx_leads_workspace_id on public.leads(workspace_id);
create index if not exists idx_leads_workspace_temperature on public.leads(workspace_id, lead_temperature);
create index if not exists idx_leads_workspace_phone on public.leads(workspace_id, phone_e164);

drop trigger if exists trg_leads_updated_at on public.leads;
create trigger trg_leads_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: public.call_attempts
-- -----------------------------------------------------------------------------
create table if not exists public.call_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null,
  attempt_number integer not null default 1 check (attempt_number >= 1),
  agent_name text not null default 'Nila',
  provider text not null default 'exotel_mock' check (provider in ('exotel_mock', 'exotel_live')),
  provider_call_sid text,
  direction text not null default 'OUTBOUND' check (direction in ('OUTBOUND', 'INBOUND')),
  status text not null default 'INITIATED' check (
    status in (
      'QUEUED',
      'INITIATED',
      'RINGING',
      'IN_PROGRESS',
      'COMPLETED',
      'NO_ANSWER',
      'BUSY',
      'FAILED',
      'CANCELLED'
    )
  ),
  call_outcome text check (
    call_outcome is null or call_outcome in (
      'CONNECTED',
      'CALLBACK_REQUESTED',
      'NO_ANSWER',
      'BUSY',
      'FAILED',
      'VOICEMAIL',
      'WRONG_NUMBER',
      'DO_NOT_CALL'
    )
  ),
  proposed_temperature text check (
    proposed_temperature is null or proposed_temperature in ('HOT', 'WARM', 'COLD', 'UNQUALIFIED')
  ),
  applied_temperature text check (
    applied_temperature is null or applied_temperature in ('HOT', 'WARM', 'COLD', 'UNQUALIFIED')
  ),
  qualification_reason text,
  summary text,
  structured_extraction jsonb not null default '{}'::jsonb,
  opt_out_requested boolean not null default false,
  callback_requested_at timestamptz,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  initiated_by_user_id uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default timezone('utc', now()),
  ended_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint call_attempts_id_workspace_unique unique (id, workspace_id),
  constraint call_attempts_lead_workspace_fk
    foreign key (lead_id, workspace_id)
    references public.leads(id, workspace_id)
    on delete cascade
);

create index if not exists idx_call_attempts_workspace_lead on public.call_attempts(workspace_id, lead_id);
create index if not exists idx_call_attempts_workspace_started on public.call_attempts(workspace_id, started_at desc);

drop trigger if exists trg_call_attempts_updated_at on public.call_attempts;
create trigger trg_call_attempts_updated_at
before update on public.call_attempts
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security & Grants
-- -----------------------------------------------------------------------------
alter table public.leads enable row level security;
alter table public.call_attempts enable row level security;

revoke all on public.leads from anon;
revoke all on public.call_attempts from anon;

grant select, insert, update, delete on public.leads to authenticated;
grant all on public.leads to service_role;

grant select, insert, update, delete on public.call_attempts to authenticated;
grant all on public.call_attempts to service_role;

drop policy if exists leads_select_member on public.leads;
create policy leads_select_member
on public.leads
for select
to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists leads_insert_member on public.leads;
create policy leads_insert_member
on public.leads
for insert
to authenticated
with check (public.is_workspace_member(workspace_id));

drop policy if exists leads_update_member on public.leads;
create policy leads_update_member
on public.leads
for update
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists leads_delete_admin on public.leads;
create policy leads_delete_admin
on public.leads
for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists call_attempts_select_member on public.call_attempts;
create policy call_attempts_select_member
on public.call_attempts
for select
to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists call_attempts_insert_member on public.call_attempts;
create policy call_attempts_insert_member
on public.call_attempts
for insert
to authenticated
with check (public.is_workspace_member(workspace_id));

drop policy if exists call_attempts_update_member on public.call_attempts;
create policy call_attempts_update_member
on public.call_attempts
for update
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists call_attempts_delete_admin on public.call_attempts;
create policy call_attempts_delete_admin
on public.call_attempts
for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

