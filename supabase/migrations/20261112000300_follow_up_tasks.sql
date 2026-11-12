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

