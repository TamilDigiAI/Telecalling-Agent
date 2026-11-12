-- =============================================================================
-- Migration 01: Workspaces and Workspace Members
-- DigiAnchorZ Voice SaaS · Multi-tenant CRM & RLS Foundation
-- =============================================================================

do $$
begin
  create extension if not exists pgcrypto;
exception
  when others then
    -- gen_random_uuid() is built into PostgreSQL 13+ core; pgcrypto is optional
    null;
end
$$;

-- Ensure Supabase-compatible roles and auth schema exist when running in local/test Postgres
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $body$;
    $fn$;
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'role'
  ) then
    execute $fn$
      create function auth.role()
      returns text
      language sql
      stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
          current_user
        )
      $body$;
    $fn$;
  end if;
end
$$;

-- Shared updated_at trigger function
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Table: public.workspaces
-- -----------------------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  agent_name text not null default 'Nila',
  app_mode text not null default 'mock' check (app_mode in ('mock', 'pilot')),
  telephony_mode text not null default 'mock' check (telephony_mode in ('mock', 'live')),
  dial_paused boolean not null default false,
  attempt_cap integer not null default 3 check (attempt_cap between 1 and 10),
  cooldown_minutes integer not null default 120 check (cooldown_minutes >= 0),
  allowed_start_hour_ist integer not null default 9 check (allowed_start_hour_ist between 0 and 23),
  allowed_end_hour_ist integer not null default 20 check (allowed_end_hour_ist between 1 and 24),
  google_sheet_id text not null default '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
  google_sheet_url text not null default 'https://docs.google.com/spreadsheets/d/1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A/edit?usp=sharing',
  google_sheet_tab text not null default 'Leads',
  allowlist_phones text[] not null default '{}',
  business_profile jsonb not null default jsonb_build_object(
    'agent_name', 'Nila',
    'primary_service', 'Meta Ads Enquiry Follow-up',
    'region', 'Tamil Nadu (Tanglish)'
  ),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_workspaces_updated_at on public.workspaces;
create trigger trg_workspaces_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: public.workspace_members
-- -----------------------------------------------------------------------------
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'agent')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint workspace_members_workspace_user_unique unique (workspace_id, user_id),
  constraint workspace_members_id_workspace_unique unique (id, workspace_id)
);

create index if not exists idx_workspace_members_user_id on public.workspace_members(user_id);
create index if not exists idx_workspace_members_workspace_id on public.workspace_members(workspace_id);

drop trigger if exists trg_workspace_members_updated_at on public.workspace_members;
create trigger trg_workspace_members_updated_at
before update on public.workspace_members
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Security Helper Functions for RLS
-- -----------------------------------------------------------------------------
create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(p_workspace_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = any(p_roles)
  );
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function public.has_workspace_role(uuid, text[]) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Row Level Security & Grants
-- -----------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

revoke all on public.workspaces from anon;
revoke all on public.workspace_members from anon;

grant select, update on public.workspaces to authenticated;
grant all on public.workspaces to service_role;

grant select, insert, update, delete on public.workspace_members to authenticated;
grant all on public.workspace_members to service_role;

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
on public.workspaces
for select
to authenticated
using (public.is_workspace_member(id));

drop policy if exists workspaces_update_admin on public.workspaces;
create policy workspaces_update_admin
on public.workspaces
for update
to authenticated
using (public.has_workspace_role(id, array['owner', 'admin']))
with check (public.has_workspace_role(id, array['owner', 'admin']));

drop policy if exists workspace_members_select_member on public.workspace_members;
create policy workspace_members_select_member
on public.workspace_members
for select
to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists workspace_members_insert_admin on public.workspace_members;
create policy workspace_members_insert_admin
on public.workspace_members
for insert
to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists workspace_members_update_admin on public.workspace_members;
create policy workspace_members_update_admin
on public.workspace_members
for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists workspace_members_delete_admin on public.workspace_members;
create policy workspace_members_delete_admin
on public.workspace_members
for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));



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



-- =============================================================================
-- Migration 03: Follow-up Tasks
-- DigiAnchorZ Voice SaaS · Founder Callbacks & Idempotent Task Scheduling
-- =============================================================================

create table if not exists public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null,
  source_call_attempt_id uuid,
  assigned_to_user_id uuid references auth.users(id) on delete set null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  task_type text not null default 'FOUNDER_CALLBACK' check (
    task_type in ('FOUNDER_CALLBACK', 'DEMO_FOLLOW_UP', 'QUOTE_FOLLOW_UP', 'MANUAL_REVIEW')
  ),
  title text not null,
  notes text,
  due_at timestamptz not null,
  status text not null default 'OPEN' check (
    status in ('OPEN', 'COMPLETED', 'CANCELLED')
  ),
  completed_at timestamptz,
  idempotency_key text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint follow_up_tasks_id_workspace_unique unique (id, workspace_id),
  constraint follow_up_tasks_workspace_attempt_unique unique (workspace_id, source_call_attempt_id),
  constraint follow_up_tasks_workspace_idempotency_unique unique (workspace_id, idempotency_key),
  constraint follow_up_tasks_lead_workspace_fk
    foreign key (lead_id, workspace_id)
    references public.leads(id, workspace_id)
    on delete cascade,
  constraint follow_up_tasks_attempt_workspace_fk
    foreign key (source_call_attempt_id, workspace_id)
    references public.call_attempts(id, workspace_id)
    on delete set null
);

create index if not exists idx_follow_up_tasks_workspace_due on public.follow_up_tasks(workspace_id, status, due_at);
create index if not exists idx_follow_up_tasks_workspace_lead on public.follow_up_tasks(workspace_id, lead_id);

drop trigger if exists trg_follow_up_tasks_updated_at on public.follow_up_tasks;
create trigger trg_follow_up_tasks_updated_at
before update on public.follow_up_tasks
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security & Grants
-- -----------------------------------------------------------------------------
alter table public.follow_up_tasks enable row level security;

revoke all on public.follow_up_tasks from anon;
grant select, insert, update, delete on public.follow_up_tasks to authenticated;
grant all on public.follow_up_tasks to service_role;

drop policy if exists follow_up_tasks_select_member on public.follow_up_tasks;
create policy follow_up_tasks_select_member
on public.follow_up_tasks
for select
to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists follow_up_tasks_insert_member on public.follow_up_tasks;
create policy follow_up_tasks_insert_member
on public.follow_up_tasks
for insert
to authenticated
with check (public.is_workspace_member(workspace_id));

drop policy if exists follow_up_tasks_update_member on public.follow_up_tasks;
create policy follow_up_tasks_update_member
on public.follow_up_tasks
for update
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists follow_up_tasks_delete_admin on public.follow_up_tasks;
create policy follow_up_tasks_delete_admin
on public.follow_up_tasks
for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));



-- =============================================================================
-- Migration 04: Lead Suppressions, Sheet Sync Jobs & Server-Side Workflows
-- DigiAnchorZ Voice SaaS · DNC Registry, Outbox Queue & Founder Bootstrap
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: public.lead_suppressions
-- -----------------------------------------------------------------------------
create table if not exists public.lead_suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid,
  source_call_attempt_id uuid,
  phone_e164 text not null,
  reason text not null default 'DO_NOT_CALL' check (
    reason in ('DO_NOT_CALL', 'USER_OPT_OUT', 'INVALID_NUMBER', 'MANUAL_SUPPRESSION', 'COMPLIANCE_BLOCK')
  ),
  notes text,
  suppressed_by_user_id uuid references auth.users(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint lead_suppressions_id_workspace_unique unique (id, workspace_id),
  constraint lead_suppressions_workspace_phone_unique unique (workspace_id, phone_e164),
  constraint lead_suppressions_lead_workspace_fk
    foreign key (lead_id, workspace_id)
    references public.leads(id, workspace_id)
    on delete set null,
  constraint lead_suppressions_attempt_workspace_fk
    foreign key (source_call_attempt_id, workspace_id)
    references public.call_attempts(id, workspace_id)
    on delete set null
);

create index if not exists idx_lead_suppressions_workspace_phone on public.lead_suppressions(workspace_id, phone_e164);

drop trigger if exists trg_lead_suppressions_updated_at on public.lead_suppressions;
create trigger trg_lead_suppressions_updated_at
before update on public.lead_suppressions
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: public.sheet_sync_jobs (Server-Side Background Job Outbox)
-- -----------------------------------------------------------------------------
create table if not exists public.sheet_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null,
  call_attempt_id uuid,
  sheet_id text not null default '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
  sheet_tab text not null default 'Leads',
  sheet_row_number integer,
  operation text not null default 'WRITE_BACK_OUTCOME' check (
    operation in ('WRITE_BACK_OUTCOME', 'WRITE_BACK_OPT_OUT', 'MANUAL_RESYNC')
  ),
  status text not null default 'PENDING' check (
    status in ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER')
  ),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts >= 1),
  locked_by text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text,
  completed_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint sheet_sync_jobs_id_workspace_unique unique (id, workspace_id),
  constraint sheet_sync_jobs_workspace_idempotency_unique unique (workspace_id, idempotency_key),
  constraint sheet_sync_jobs_lead_workspace_fk
    foreign key (lead_id, workspace_id)
    references public.leads(id, workspace_id)
    on delete cascade,
  constraint sheet_sync_jobs_attempt_workspace_fk
    foreign key (call_attempt_id, workspace_id)
    references public.call_attempts(id, workspace_id)
    on delete set null
);

create index if not exists idx_sheet_sync_jobs_workspace_status on public.sheet_sync_jobs(workspace_id, status, next_attempt_at);
create index if not exists idx_sheet_sync_jobs_lead_id on public.sheet_sync_jobs(workspace_id, lead_id);

drop trigger if exists trg_sheet_sync_jobs_updated_at on public.sheet_sync_jobs;
create trigger trg_sheet_sync_jobs_updated_at
before update on public.sheet_sync_jobs
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security & Grants
-- -----------------------------------------------------------------------------
alter table public.lead_suppressions enable row level security;
alter table public.sheet_sync_jobs enable row level security;

revoke all on public.lead_suppressions from anon;
grant select, insert, update, delete on public.lead_suppressions to authenticated;
grant all on public.lead_suppressions to service_role;

-- Keep background job writes server-side: authenticated users can only SELECT their workspace jobs
revoke all on public.sheet_sync_jobs from anon, authenticated;
grant select on public.sheet_sync_jobs to authenticated;
grant all on public.sheet_sync_jobs to service_role;

drop policy if exists lead_suppressions_select_member on public.lead_suppressions;
create policy lead_suppressions_select_member
on public.lead_suppressions
for select
to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists lead_suppressions_insert_member on public.lead_suppressions;
create policy lead_suppressions_insert_member
on public.lead_suppressions
for insert
to authenticated
with check (public.is_workspace_member(workspace_id));

drop policy if exists lead_suppressions_update_member on public.lead_suppressions;
create policy lead_suppressions_update_member
on public.lead_suppressions
for update
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop policy if exists lead_suppressions_delete_admin on public.lead_suppressions;
create policy lead_suppressions_delete_admin
on public.lead_suppressions
for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists sheet_sync_jobs_select_member on public.sheet_sync_jobs;
create policy sheet_sync_jobs_select_member
on public.sheet_sync_jobs
for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- -----------------------------------------------------------------------------
-- Atomic Call Outcome + Single Callback Task + Server-Side Sheet Outbox RPC
-- -----------------------------------------------------------------------------
create or replace function public.record_call_outcome_and_follow_up(
  p_workspace_id uuid,
  p_lead_id uuid,
  p_call_outcome text,
  p_proposed_temperature text,
  p_qualification_reason text,
  p_summary text,
  p_callback_at timestamptz default null,
  p_opt_out boolean default false,
  p_call_attempt_id uuid default null,
  p_structured_extraction jsonb default '{}'::jsonb,
  p_duration_seconds integer default 95
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_workspace public.workspaces%rowtype;
  v_attempt_id uuid;
  v_attempt_number integer;
  v_applied_temp text;
  v_status text;
  v_task_id uuid;
  v_job_id uuid;
  v_caller_uid uuid := auth.uid();
  v_caller_role text := coalesce(auth.role(), '');
  v_is_server boolean := (
    v_caller_role = 'service_role'
    or (v_caller_uid is null and v_caller_role in ('postgres', 'supabase_admin'))
  );
begin
  if not v_is_server and not public.is_workspace_member(p_workspace_id) then
    raise exception 'Access denied: caller is not an authenticated member of workspace %', p_workspace_id
      using errcode = '42501';
  end if;

  select * into v_workspace
  from public.workspaces
  where id = p_workspace_id;

  if not found then
    raise exception 'Workspace % not found', p_workspace_id using errcode = 'P0002';
  end if;

  select * into v_lead
  from public.leads
  where id = p_lead_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'Lead % does not belong to workspace %', p_lead_id, p_workspace_id
      using errcode = '23503';
  end if;

  -- Qualification Rule: HOT requires concrete callback/next action; unanswered retries preserve prior HOT/WARM rating
  if p_opt_out or p_call_outcome = 'DO_NOT_CALL' then
    v_applied_temp := case
      when p_proposed_temperature in ('HOT', 'WARM', 'COLD', 'UNQUALIFIED') then p_proposed_temperature
      else 'COLD'
    end;
    v_status := 'COMPLETED';
  elsif p_call_outcome in ('NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL') then
    v_applied_temp := case
      when v_lead.lead_temperature in ('HOT', 'WARM') then v_lead.lead_temperature
      else 'UNQUALIFIED'
    end;
    v_status := case
      when p_call_outcome in ('NO_ANSWER', 'BUSY', 'FAILED') then p_call_outcome
      else 'COMPLETED'
    end;
  else
    v_applied_temp := coalesce(p_proposed_temperature, 'UNQUALIFIED');
    if v_applied_temp = 'HOT' and p_callback_at is null and coalesce(p_structured_extraction ->> 'next_action', '') = '' then
      raise exception 'HOT qualification requires an agreed callback time or concrete next step'
        using errcode = '22023';
    end if;
    v_status := 'COMPLETED';
  end if;

  if p_call_attempt_id is not null then
    select id, attempt_number into v_attempt_id, v_attempt_number
    from public.call_attempts
    where id = p_call_attempt_id and workspace_id = p_workspace_id and lead_id = p_lead_id;
  end if;

  if v_attempt_id is null then
    v_attempt_id := coalesce(p_call_attempt_id, gen_random_uuid());
    v_attempt_number := v_lead.attempts_count + 1;

    insert into public.call_attempts (
      id,
      workspace_id,
      lead_id,
      attempt_number,
      agent_name,
      provider,
      provider_call_sid,
      direction,
      status,
      call_outcome,
      proposed_temperature,
      applied_temperature,
      qualification_reason,
      summary,
      structured_extraction,
      opt_out_requested,
      callback_requested_at,
      duration_seconds,
      initiated_by_user_id,
      started_at,
      ended_at
    ) values (
      v_attempt_id,
      p_workspace_id,
      p_lead_id,
      v_attempt_number,
      v_workspace.agent_name,
      case when v_workspace.telephony_mode = 'live' then 'exotel_live' else 'exotel_mock' end,
      'mock-exo-' || replace(v_attempt_id::text, '-', ''),
      'OUTBOUND',
      v_status,
      p_call_outcome,
      p_proposed_temperature,
      v_applied_temp,
      p_qualification_reason,
      p_summary,
      coalesce(p_structured_extraction, '{}'::jsonb),
      p_opt_out or (p_call_outcome = 'DO_NOT_CALL'),
      p_callback_at,
      coalesce(p_duration_seconds, 95),
      coalesce(v_caller_uid, v_lead.owner_user_id),
      timezone('utc', now()) - make_interval(secs => coalesce(p_duration_seconds, 95)),
      timezone('utc', now())
    );
  else
    update public.call_attempts
    set status = v_status,
        call_outcome = p_call_outcome,
        proposed_temperature = p_proposed_temperature,
        applied_temperature = v_applied_temp,
        qualification_reason = p_qualification_reason,
        summary = p_summary,
        structured_extraction = coalesce(p_structured_extraction, '{}'::jsonb),
        opt_out_requested = p_opt_out or (p_call_outcome = 'DO_NOT_CALL'),
        callback_requested_at = p_callback_at,
        duration_seconds = coalesce(p_duration_seconds, duration_seconds),
        ended_at = timezone('utc', now())
    where id = v_attempt_id and workspace_id = p_workspace_id;
  end if;

  -- Update Lead record
  update public.leads
  set lead_temperature = v_applied_temp,
      latest_call_outcome = p_call_outcome,
      qualification_reason = coalesce(p_qualification_reason, qualification_reason),
      call_summary = coalesce(p_summary, call_summary),
      need_summary = coalesce(p_structured_extraction ->> 'need', need_summary),
      timeline = coalesce(p_structured_extraction ->> 'timeline', timeline),
      budget_band = coalesce(p_structured_extraction ->> 'budget_band', budget_band),
      next_action = coalesce(
        p_structured_extraction ->> 'next_action',
        case when p_callback_at is not null then 'Founder callback scheduled' else next_action end
      ),
      callback_at = coalesce(p_callback_at, callback_at),
      last_call_at = timezone('utc', now()),
      attempts_count = greatest(attempts_count, v_attempt_number),
      do_not_call = do_not_call or p_opt_out or (p_call_outcome = 'DO_NOT_CALL'),
      sync_status = 'PENDING'
  where id = p_lead_id and workspace_id = p_workspace_id;

  -- Handle Do-Not-Call / Opt-Out
  if p_opt_out or p_call_outcome = 'DO_NOT_CALL' then
    insert into public.lead_suppressions (
      workspace_id,
      lead_id,
      source_call_attempt_id,
      phone_e164,
      reason,
      notes,
      suppressed_by_user_id,
      active
    ) values (
      p_workspace_id,
      p_lead_id,
      v_attempt_id,
      v_lead.phone_e164,
      'USER_OPT_OUT',
      coalesce(p_summary, 'Lead requested Do Not Call during voice qualification'),
      v_caller_uid,
      true
    )
    on conflict (workspace_id, phone_e164) do update
    set active = true,
        lead_id = excluded.lead_id,
        source_call_attempt_id = excluded.source_call_attempt_id,
        reason = excluded.reason,
        notes = excluded.notes;

    update public.follow_up_tasks
    set status = 'CANCELLED'
    where workspace_id = p_workspace_id
      and lead_id = p_lead_id
      and status = 'OPEN';
  elsif p_callback_at is not null then
    -- Upsert exactly ONE founder callback task for this call attempt
    insert into public.follow_up_tasks (
      workspace_id,
      lead_id,
      source_call_attempt_id,
      assigned_to_user_id,
      created_by_user_id,
      task_type,
      title,
      notes,
      due_at,
      status,
      idempotency_key
    ) values (
      p_workspace_id,
      p_lead_id,
      v_attempt_id,
      coalesce(v_lead.owner_user_id, v_caller_uid),
      coalesce(v_caller_uid, v_lead.owner_user_id),
      'FOUNDER_CALLBACK',
      'Founder callback: ' || v_lead.full_name || ' (' || v_lead.service_interest || ')',
      coalesce(p_summary, p_qualification_reason),
      p_callback_at,
      'OPEN',
      'attempt-callback:' || v_attempt_id::text
    )
    on conflict (workspace_id, source_call_attempt_id) do update
    set due_at = excluded.due_at,
        title = excluded.title,
        notes = excluded.notes,
        status = 'OPEN'
    returning id into v_task_id;
  end if;

  -- Enqueue server-side Google Sheet write-back job (idempotent per attempt)
  insert into public.sheet_sync_jobs (
    workspace_id,
    lead_id,
    call_attempt_id,
    sheet_id,
    sheet_tab,
    sheet_row_number,
    operation,
    status,
    payload,
    idempotency_key
  ) values (
    p_workspace_id,
    p_lead_id,
    v_attempt_id,
    v_lead.sheet_id,
    v_lead.sheet_tab,
    v_lead.sheet_row_number,
    case when p_opt_out or p_call_outcome = 'DO_NOT_CALL' then 'WRITE_BACK_OPT_OUT' else 'WRITE_BACK_OUTCOME' end,
    'PENDING',
    jsonb_build_object(
      'crm_lead_id', p_lead_id,
      'external_lead_id', v_lead.external_lead_id,
      'call_outcome', p_call_outcome,
      'lead_temperature', v_applied_temp,
      'qualification_reason', p_qualification_reason,
      'call_summary', p_summary,
      'callback_at', p_callback_at,
      'agent_name', v_workspace.agent_name,
      'do_not_call', (p_opt_out or p_call_outcome = 'DO_NOT_CALL')
    ),
    'sheet-sync:attempt:' || v_attempt_id::text
  )
  on conflict (workspace_id, idempotency_key) do update
  set payload = excluded.payload,
      status = 'PENDING'
  returning id into v_job_id;

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'lead_id', p_lead_id,
    'call_attempt_id', v_attempt_id,
    'follow_up_task_id', v_task_id,
    'sheet_sync_job_id', v_job_id,
    'applied_temperature', v_applied_temp,
    'call_outcome', p_call_outcome
  );
end;
$$;

grant execute on function public.record_call_outcome_and_follow_up(
  uuid, uuid, text, text, text, text, timestamptz, boolean, uuid, jsonb, integer
) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Documented Founder Bootstrap Function (Server/Admin Only)
-- Assigns an existing Supabase Auth user ID as owner of DigiAnchorZ workspace
-- and creates the synthetic test lead.
-- -----------------------------------------------------------------------------
create or replace function public.bootstrap_digianchorz_founder(
  p_user_id uuid,
  p_email text default 'founder@digianchorz.com'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_email text;
  v_workspace_id uuid;
  v_member_id uuid;
  v_lead_id uuid;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'bootstrap_digianchorz_founder must be executed with server admin / service_role privileges'
      using errcode = '42501';
  end if;

  select coalesce(email, p_email) into v_user_email
  from auth.users
  where id = p_user_id;

  if not found then
    raise exception 'Supabase Auth user % does not exist in auth.users', p_user_id
      using errcode = 'P0002';
  end if;

  insert into public.workspaces (
    slug,
    name,
    timezone,
    agent_name,
    app_mode,
    telephony_mode,
    google_sheet_id,
    google_sheet_url,
    google_sheet_tab,
    business_profile
  ) values (
    'digianchorz',
    'DigiAnchorZ',
    'Asia/Kolkata',
    'Nila',
    'mock',
    'mock',
    '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
    'https://docs.google.com/spreadsheets/d/1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A/edit?usp=sharing',
    'Leads',
    jsonb_build_object(
      'agent_name', 'Nila',
      'company', 'DigiAnchorZ',
      'primary_service', 'Meta Ads & Performance Marketing Enquiry Follow-up',
      'language', 'Tanglish (Tamil Nadu)',
      'google_sheet_id', '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A'
    )
  )
  on conflict (slug) do update
  set name = excluded.name,
      agent_name = 'Nila',
      google_sheet_id = '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
      google_sheet_url = 'https://docs.google.com/spreadsheets/d/1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A/edit?usp=sharing'
  returning id into v_workspace_id;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    email,
    role
  ) values (
    v_workspace_id,
    p_user_id,
    v_user_email,
    'owner'
  )
  on conflict (workspace_id, user_id) do update
  set role = 'owner',
      email = excluded.email
  returning id into v_member_id;

  -- Upsert synthetic test lead in the DigiAnchorZ workspace
  insert into public.leads (
    workspace_id,
    external_lead_id,
    sheet_id,
    sheet_tab,
    sheet_row_number,
    full_name,
    raw_phone,
    phone_e164,
    service_interest,
    source,
    calling_eligibility,
    eligibility_reference,
    available_window,
    do_not_call,
    lead_temperature,
    owner_user_id,
    sync_status
  ) values (
    v_workspace_id,
    'DAZ-SYNTH-LEAD-001',
    '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
    'Leads',
    2,
    'Karthik Subramanian',
    '98765 43210',
    '+919876543210',
    'Meta Ads Enquiry Follow-up',
    'Google Sheet',
    'ELIGIBLE',
    'GSHEET-1X9sQhlRx-ROW-2-ENQUIRY-CONSENT',
    '10:00-19:00 IST',
    false,
    'UNQUALIFIED',
    p_user_id,
    'PENDING'
  )
  on conflict (workspace_id, external_lead_id) do update
  set owner_user_id = excluded.owner_user_id,
      sheet_id = excluded.sheet_id
  returning id into v_lead_id;

  return jsonb_build_object(
    'workspace_id', v_workspace_id,
    'workspace_slug', 'digianchorz',
    'workspace_name', 'DigiAnchorZ',
    'agent_name', 'Nila',
    'google_sheet_id', '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A',
    'member_id', v_member_id,
    'owner_user_id', p_user_id,
    'owner_email', v_user_email,
    'synthetic_lead_id', v_lead_id,
    'synthetic_external_lead_id', 'DAZ-SYNTH-LEAD-001'
  );
end;
$$;

revoke all on function public.bootstrap_digianchorz_founder(uuid, text) from public, anon, authenticated;
grant execute on function public.bootstrap_digianchorz_founder(uuid, text) to service_role;



-- =============================================================================
-- Migration 05: Owner-Only Business Settings, Nila Knowledge & Pilot Rules
-- DigiAnchorZ Voice SaaS · Tamilselvan Marimuthu (Karur, Tamil Nadu)
-- =============================================================================

-- 1. Set default DigiAnchorZ business_profile JSONB on workspaces
alter table public.workspaces
alter column business_profile set default jsonb_build_object(
  'business_name', 'DigiAnchorZ',
  'founder_name', 'Tamilselvan Marimuthu',
  'location', 'Karur, Tamil Nadu',
  'website', 'https://digianchorz.com',
  'positioning', 'AI-driven digital marketing and automation agency.',
  'default_language', 'Natural Tamil Nadu Tanglish',
  'pilot_primary_service', 'Meta Ads for Facebook and Instagram lead generation',
  'service_catalog', jsonb_build_array(
    'Meta Ads for Facebook and Instagram lead generation',
    'Google Ads for search-driven enquiries',
    'SEO and Local SEO for search visibility',
    'Website and landing page development',
    'WhatsApp automation, lead follow-up, and CRM workflows',
    'Branding and video content production'
  ),
  'founder_settings', jsonb_build_object(
    'approved_service_fees', '',
    'minimum_ad_budget', '',
    'discovery_call_fee_policy', '',
    'callback_schedule', '',
    'escalation_contacts', '',
    'approved_proof_points', '',
    'service_locations_and_exclusions', ''
  ),
  'approved_faqs', jsonb_build_object(
    'how_much_do_you_charge', 'உங்க goal, campaign scope, ad budget தெரிஞ்சா team சரியான quote சொல்ல முடியும்.',
    'can_you_guarantee_leads_or_sales', 'Campaign setup, tracking, optimization பண்ண முடியும். Results உங்க offer, audience, budget, follow-up இதைப் பொறுத்து மாறும்.',
    'we_already_have_an_agency', 'சரி. இப்போ எந்த விஷயம் இன்னும் better-ஆ இருந்தா உங்களுக்கு useful-ஆ இருக்கும்?',
    'just_send_me_the_details', 'உங்களுக்கு எந்த service details வேணும், எந்த channel-ல (WhatsApp / Email) அனுப்பணும்னு நோட் பண்ணிக்கிட்டேன்ங்க. எங்க team உங்களுக்கு அனுப்பி வைப்பாங்க.'
  )
);

-- Update existing DigiAnchorZ workspace if present so its business_profile has the full catalog & blank founder settings
update public.workspaces
set business_profile = jsonb_build_object(
  'business_name', 'DigiAnchorZ',
  'founder_name', 'Tamilselvan Marimuthu',
  'location', 'Karur, Tamil Nadu',
  'website', 'https://digianchorz.com',
  'positioning', 'AI-driven digital marketing and automation agency.',
  'default_language', 'Natural Tamil Nadu Tanglish',
  'pilot_primary_service', 'Meta Ads for Facebook and Instagram lead generation',
  'service_catalog', jsonb_build_array(
    'Meta Ads for Facebook and Instagram lead generation',
    'Google Ads for search-driven enquiries',
    'SEO and Local SEO for search visibility',
    'Website and landing page development',
    'WhatsApp automation, lead follow-up, and CRM workflows',
    'Branding and video content production'
  ),
  'founder_settings', coalesce(
    business_profile -> 'founder_settings',
    jsonb_build_object(
      'approved_service_fees', '',
      'minimum_ad_budget', '',
      'discovery_call_fee_policy', '',
      'callback_schedule', '',
      'escalation_contacts', '',
      'approved_proof_points', '',
      'service_locations_and_exclusions', ''
    )
  ),
  'approved_faqs', coalesce(
    business_profile -> 'approved_faqs',
    jsonb_build_object(
      'how_much_do_you_charge', 'உங்க goal, campaign scope, ad budget தெரிஞ்சா team சரியான quote சொல்ல முடியும்.',
      'can_you_guarantee_leads_or_sales', 'Campaign setup, tracking, optimization பண்ண முடியும். Results உங்க offer, audience, budget, follow-up இதைப் பொறுத்து மாறும்.',
      'we_already_have_an_agency', 'சரி. இப்போ எந்த விஷயம் இன்னும் better-ஆ இருந்தா உங்களுக்கு useful-ஆ இருக்கும்?',
      'just_send_me_the_details', 'உங்களுக்கு எந்த service details வேணும், எந்த channel-ல (WhatsApp / Email) அனுப்பணும்னு நோட் பண்ணிக்கிட்டேன்ங்க. எங்க team உங்களுக்கு அனுப்பி வைப்பாங்க.'
    )
  )
)
where slug = 'digianchorz';

-- 2. Restrict workspace updates (including Business Settings) strictly to workspace OWNER
drop policy if exists workspaces_update_admin on public.workspaces;
drop policy if exists workspaces_update_owner on public.workspaces;
create policy workspaces_update_owner
on public.workspaces
for update
to authenticated
using (public.has_workspace_role(id, array['owner']))
with check (public.has_workspace_role(id, array['owner']));

-- Owner-only RPC to update Business Settings without changing code
create or replace function public.update_workspace_business_settings(
  p_workspace_id uuid,
  p_business_profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_uid uuid := auth.uid();
  v_caller_role text := coalesce(auth.role(), '');
  v_is_server boolean := (
    v_caller_role = 'service_role'
    or (v_caller_uid is null and v_caller_role in ('postgres', 'supabase_admin'))
  );
  v_updated jsonb;
begin
  if not v_is_server and not public.has_workspace_role(p_workspace_id, array['owner']) then
    raise exception 'Owner access required: only the workspace owner can update Business Settings'
      using errcode = '42501';
  end if;

  update public.workspaces
  set business_profile = p_business_profile
  where id = p_workspace_id
  returning business_profile into v_updated;

  if not found then
    raise exception 'Workspace % not found', p_workspace_id using errcode = 'P0002';
  end if;

  return v_updated;
end;
$$;

grant execute on function public.update_workspace_business_settings(uuid, jsonb) to authenticated, service_role;

-- 3. Pre-dial suppression check & Pilot Qualification Rules in record_call_outcome_and_follow_up
create or replace function public.record_call_outcome_and_follow_up(
  p_workspace_id uuid,
  p_lead_id uuid,
  p_call_outcome text,
  p_proposed_temperature text,
  p_qualification_reason text,
  p_summary text,
  p_callback_at timestamptz default null,
  p_opt_out boolean default false,
  p_call_attempt_id uuid default null,
  p_structured_extraction jsonb default '{}'::jsonb,
  p_duration_seconds integer default 95
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_workspace public.workspaces%rowtype;
  v_attempt_id uuid;
  v_attempt_number integer;
  v_applied_temp text;
  v_status text;
  v_task_id uuid;
  v_task_type text;
  v_task_title text;
  v_job_id uuid;
  v_suppressed boolean := false;
  v_slot_configured boolean := false;
  v_requires_quote_followup boolean := false;
  v_caller_uid uuid := auth.uid();
  v_caller_role text := coalesce(auth.role(), '');
  v_is_server boolean := (
    v_caller_role = 'service_role'
    or (v_caller_uid is null and v_caller_role in ('postgres', 'supabase_admin'))
  );
begin
  if not v_is_server and not public.is_workspace_member(p_workspace_id) then
    raise exception 'Access denied: caller is not an authenticated member of workspace %', p_workspace_id
      using errcode = '42501';
  end if;

  select * into v_workspace
  from public.workspaces
  where id = p_workspace_id;

  if not found then
    raise exception 'Workspace % not found', p_workspace_id using errcode = 'P0002';
  end if;

  select * into v_lead
  from public.leads
  where id = p_lead_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'Lead % does not belong to workspace %', p_lead_id, p_workspace_id
      using errcode = '23503';
  end if;

  -- Check if lead or phone_e164 is already opted-out / suppressed before allowing a new call attempt
  select exists (
    select 1
    from public.lead_suppressions ls
    where ls.workspace_id = p_workspace_id
      and ls.phone_e164 = v_lead.phone_e164
      and ls.active = true
  ) into v_suppressed;

  if p_call_attempt_id is not null then
    select id, attempt_number into v_attempt_id, v_attempt_number
    from public.call_attempts
    where id = p_call_attempt_id and workspace_id = p_workspace_id and lead_id = p_lead_id;
  end if;

  -- If this is a new call attempt (not an idempotent retry of the same attempt), block if opted out
  if v_attempt_id is null and (v_lead.do_not_call or v_suppressed) then
    raise exception 'Call blocked: lead % (%) has opted out (DO_NOT_CALL suppression active)',
      v_lead.full_name, v_lead.phone_e164
      using errcode = 'P0001';
  end if;

  -- Qualification Rules:
  -- 1. Opt-out blocks future calls regardless of temperature.
  -- 2. Missed call (NO_ANSWER / BUSY / FAILED / VOICEMAIL) does NOT make a lead COLD; stays UNQUALIFIED (or preserves prior HOT/WARM).
  -- 3. Generic "call later" without a confirmed need stays UNQUALIFIED.
  -- 4. HOT requires current need and an agreed concrete next step (callback or quote discussion).
  -- 5. WARM has relevant interest with timing or next step still undecided.
  if p_opt_out or p_call_outcome = 'DO_NOT_CALL' then
    v_applied_temp := case
      when p_proposed_temperature in ('HOT', 'WARM', 'COLD', 'UNQUALIFIED') then p_proposed_temperature
      else v_lead.lead_temperature
    end;
    v_status := 'COMPLETED';
  elsif p_call_outcome in ('NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL') then
    v_applied_temp := case
      when v_lead.lead_temperature in ('HOT', 'WARM') then v_lead.lead_temperature
      else 'UNQUALIFIED'
    end;
    v_status := case
      when p_call_outcome in ('NO_ANSWER', 'BUSY', 'FAILED') then p_call_outcome
      else 'COMPLETED'
    end;
  else
    v_applied_temp := coalesce(p_proposed_temperature, 'UNQUALIFIED');
    if v_applied_temp = 'HOT'
       and p_callback_at is null
       and coalesce(p_structured_extraction ->> 'next_action', '') = '' then
      raise exception 'HOT qualification requires a current need and an agreed concrete next step or callback'
        using errcode = '22023';
    end if;
    v_status := 'COMPLETED';
  end if;

  if v_attempt_id is null then
    v_attempt_id := coalesce(p_call_attempt_id, gen_random_uuid());
    v_attempt_number := v_lead.attempts_count + 1;

    insert into public.call_attempts (
      id,
      workspace_id,
      lead_id,
      attempt_number,
      agent_name,
      provider,
      provider_call_sid,
      direction,
      status,
      call_outcome,
      proposed_temperature,
      applied_temperature,
      qualification_reason,
      summary,
      structured_extraction,
      opt_out_requested,
      callback_requested_at,
      duration_seconds,
      initiated_by_user_id,
      started_at,
      ended_at
    ) values (
      v_attempt_id,
      p_workspace_id,
      p_lead_id,
      v_attempt_number,
      v_workspace.agent_name,
      case when v_workspace.telephony_mode = 'live' then 'exotel_live' else 'exotel_mock' end,
      'mock-exo-' || replace(v_attempt_id::text, '-', ''),
      'OUTBOUND',
      v_status,
      p_call_outcome,
      p_proposed_temperature,
      v_applied_temp,
      p_qualification_reason,
      p_summary,
      coalesce(p_structured_extraction, '{}'::jsonb),
      p_opt_out or (p_call_outcome = 'DO_NOT_CALL'),
      p_callback_at,
      coalesce(p_duration_seconds, 95),
      coalesce(v_caller_uid, v_lead.owner_user_id),
      timezone('utc', now()) - make_interval(secs => coalesce(p_duration_seconds, 95)),
      timezone('utc', now())
    );
  else
    update public.call_attempts
    set status = v_status,
        call_outcome = p_call_outcome,
        proposed_temperature = p_proposed_temperature,
        applied_temperature = v_applied_temp,
        qualification_reason = p_qualification_reason,
        summary = p_summary,
        structured_extraction = coalesce(p_structured_extraction, '{}'::jsonb),
        opt_out_requested = p_opt_out or (p_call_outcome = 'DO_NOT_CALL'),
        callback_requested_at = p_callback_at,
        duration_seconds = coalesce(p_duration_seconds, duration_seconds),
        ended_at = timezone('utc', now())
    where id = v_attempt_id and workspace_id = p_workspace_id;
  end if;

  -- Update Lead record
  update public.leads
  set lead_temperature = v_applied_temp,
      latest_call_outcome = p_call_outcome,
      qualification_reason = coalesce(p_qualification_reason, qualification_reason),
      call_summary = coalesce(p_summary, call_summary),
      need_summary = coalesce(p_structured_extraction ->> 'need', need_summary),
      timeline = coalesce(p_structured_extraction ->> 'timeline', timeline),
      budget_band = coalesce(p_structured_extraction ->> 'budget_band', budget_band),
      next_action = coalesce(
        p_structured_extraction ->> 'next_action',
        case when p_callback_at is not null then 'Founder callback scheduled' else next_action end
      ),
      callback_at = coalesce(p_callback_at, callback_at),
      last_call_at = timezone('utc', now()),
      attempts_count = greatest(attempts_count, v_attempt_number),
      do_not_call = do_not_call or p_opt_out or (p_call_outcome = 'DO_NOT_CALL'),
      sync_status = 'PENDING'
  where id = p_lead_id and workspace_id = p_workspace_id;

  -- Check if callback slots are configured in founder_settings
  v_slot_configured := coalesce(
    nullif(trim(v_workspace.business_profile #>> '{founder_settings,callback_schedule}'), ''),
    ''
  ) <> '';

  v_requires_quote_followup := coalesce(
    (p_structured_extraction ->> 'pricing_question_without_approved_rate')::boolean,
    false
  );

  if p_opt_out or p_call_outcome = 'DO_NOT_CALL' then
    insert into public.lead_suppressions (
      workspace_id,
      lead_id,
      source_call_attempt_id,
      phone_e164,
      reason,
      notes,
      suppressed_by_user_id,
      active
    ) values (
      p_workspace_id,
      p_lead_id,
      v_attempt_id,
      v_lead.phone_e164,
      'USER_OPT_OUT',
      coalesce(p_summary, 'Lead requested Do Not Call during voice qualification'),
      v_caller_uid,
      true
    )
    on conflict (workspace_id, phone_e164) do update
    set active = true,
        lead_id = excluded.lead_id,
        source_call_attempt_id = excluded.source_call_attempt_id,
        reason = excluded.reason,
        notes = excluded.notes;

    update public.follow_up_tasks
    set status = 'CANCELLED'
    where workspace_id = p_workspace_id
      and lead_id = p_lead_id
      and status = 'OPEN';
  elsif p_callback_at is not null or v_requires_quote_followup then
    v_task_type := case
      when v_requires_quote_followup then 'QUOTE_FOLLOW_UP'
      else 'FOUNDER_CALLBACK'
    end;

    v_task_title := case
      when v_requires_quote_followup then
        'Founder quote follow-up (no approved rate configured): ' || v_lead.full_name || ' (' || v_lead.service_interest || ')'
      when v_slot_configured then
        'Confirmed founder callback: ' || v_lead.full_name || ' (' || v_lead.service_interest || ')'
      else
        'Founder callback request (slot review needed): ' || v_lead.full_name || ' (' || v_lead.service_interest || ')'
    end;

    insert into public.follow_up_tasks (
      workspace_id,
      lead_id,
      source_call_attempt_id,
      assigned_to_user_id,
      created_by_user_id,
      task_type,
      title,
      notes,
      due_at,
      status,
      idempotency_key
    ) values (
      p_workspace_id,
      p_lead_id,
      v_attempt_id,
      coalesce(v_lead.owner_user_id, v_caller_uid),
      coalesce(v_caller_uid, v_lead.owner_user_id),
      v_task_type,
      v_task_title,
      coalesce(p_summary, p_qualification_reason),
      coalesce(p_callback_at, timezone('utc', now()) + interval '4 hours'),
      'OPEN',
      'attempt-callback:' || v_attempt_id::text
    )
    on conflict (workspace_id, source_call_attempt_id) do update
    set due_at = excluded.due_at,
        task_type = excluded.task_type,
        title = excluded.title,
        notes = excluded.notes,
        status = 'OPEN'
    returning id into v_task_id;
  end if;

  -- Enqueue server-side Google Sheet write-back job (idempotent per attempt)
  insert into public.sheet_sync_jobs (
    workspace_id,
    lead_id,
    call_attempt_id,
    sheet_id,
    sheet_tab,
    sheet_row_number,
    operation,
    status,
    payload,
    idempotency_key
  ) values (
    p_workspace_id,
    p_lead_id,
    v_attempt_id,
    v_lead.sheet_id,
    v_lead.sheet_tab,
    v_lead.sheet_row_number,
    case when p_opt_out or p_call_outcome = 'DO_NOT_CALL' then 'WRITE_BACK_OPT_OUT' else 'WRITE_BACK_OUTCOME' end,
    'PENDING',
    jsonb_build_object(
      'crm_lead_id', p_lead_id,
      'external_lead_id', v_lead.external_lead_id,
      'call_outcome', p_call_outcome,
      'lead_temperature', v_applied_temp,
      'qualification_reason', p_qualification_reason,
      'call_summary', p_summary,
      'callback_at', p_callback_at,
      'slot_verified', (v_slot_configured and v_task_id is not null),
      'agent_name', v_workspace.agent_name,
      'do_not_call', (p_opt_out or p_call_outcome = 'DO_NOT_CALL')
    ),
    'sheet-sync:attempt:' || v_attempt_id::text
  )
  on conflict (workspace_id, idempotency_key) do update
  set payload = excluded.payload,
      status = 'PENDING'
  returning id into v_job_id;

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'lead_id', p_lead_id,
    'call_attempt_id', v_attempt_id,
    'follow_up_task_id', v_task_id,
    'sheet_sync_job_id', v_job_id,
    'applied_temperature', v_applied_temp,
    'call_outcome', p_call_outcome,
    'slot_verified', (v_slot_configured and v_task_id is not null)
  );
end;
$$;



-- Bootstrap Founder Account (30f1dac0-686d-47f4-94f3-acd3d55cc0ed / pheonixtamil2025@gmail.com)
SELECT public.bootstrap_digianchorz_founder('30f1dac0-686d-47f4-94f3-acd3d55cc0ed'::uuid, 'pheonixtamil2025@gmail.com');
