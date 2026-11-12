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

