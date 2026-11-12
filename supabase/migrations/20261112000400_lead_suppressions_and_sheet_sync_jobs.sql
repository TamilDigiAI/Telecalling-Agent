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

