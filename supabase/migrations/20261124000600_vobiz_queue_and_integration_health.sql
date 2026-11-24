-- =============================================================================
-- Migration 06: Vobiz Telephony, Durable Call Queue, Integration Errors & Sync Leasing
-- DigiAnchorZ Voice SaaS · Agent Nila (Vobiz + Sarvam Ritu + n8n + Google Sheets)
-- =============================================================================

-- 1. Expand call_attempts for Vobiz provider tracking, reconciliation, and idempotency
alter table public.call_attempts
  drop constraint if exists call_attempts_provider_check;

alter table public.call_attempts
  add constraint call_attempts_provider_check
  check (provider in ('vobiz_live', 'vobiz_mock', 'exotel_mock', 'exotel_live'));

alter table public.call_attempts
  add column if not exists provider_request_uuid text,
  add column if not exists provider_account_id text,
  add column if not exists provider_raw_status text,
  add column if not exists provider_error_code text,
  add column if not exists reconciliation_required boolean not null default false,
  add column if not exists idempotency_key text;

create unique index if not exists idx_call_attempts_workspace_idempotency
  on public.call_attempts(workspace_id, idempotency_key)
  where idempotency_key is not null;

-- 2. Add row-bound metadata and review flags on leads for Google Sheet matching
alter table public.leads
  add column if not exists row_bound_key text,
  add column if not exists flagged_for_review boolean not null default false,
  add column if not exists review_reason text;

-- 3. Durable Call Queue (`public.call_queue_jobs`)
create table if not exists public.call_queue_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'CLAIMED', 'DIALING', 'COMPLETED', 'CANCELLED', 'FAILED', 'RECONCILING')
  ),
  idempotency_key text not null,
  scheduled_for timestamptz not null default timezone('utc', now()),
  locked_by text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts >= 1),
  call_attempt_id uuid,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint call_queue_jobs_workspace_idempotency_unique unique (workspace_id, idempotency_key),
  constraint call_queue_jobs_lead_workspace_fk
    foreign key (lead_id, workspace_id)
    references public.leads(id, workspace_id)
    on delete cascade,
  constraint call_queue_jobs_attempt_workspace_fk
    foreign key (call_attempt_id, workspace_id)
    references public.call_attempts(id, workspace_id)
    on delete set null
);

-- Guarantee at most ONE active/pending queued call job per lead in a workspace
create unique index if not exists idx_call_queue_one_active_per_lead
  on public.call_queue_jobs(workspace_id, lead_id)
  where status in ('PENDING', 'CLAIMED', 'DIALING', 'RECONCILING');

create index if not exists idx_call_queue_jobs_workspace_status
  on public.call_queue_jobs(workspace_id, status, scheduled_for);

drop trigger if exists trg_call_queue_jobs_updated_at on public.call_queue_jobs;
create trigger trg_call_queue_jobs_updated_at
before update on public.call_queue_jobs
for each row execute function public.set_updated_at();

alter table public.call_queue_jobs enable row level security;
revoke all on public.call_queue_jobs from anon, authenticated;
grant select on public.call_queue_jobs to authenticated;
grant all on public.call_queue_jobs to service_role;

drop policy if exists call_queue_jobs_select_member on public.call_queue_jobs;
create policy call_queue_jobs_select_member
on public.call_queue_jobs
for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- 4. Sanitized Integration Errors table (`public.integration_errors`) for n8n Workflow C
create table if not exists public.integration_errors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null default 'n8n' check (
    source in ('n8n', 'vobiz', 'sarvam', 'google_sheets', 'supabase')
  ),
  workflow_name text,
  execution_id text,
  node_name text,
  error_code text,
  sanitized_message text not null,
  metadata jsonb not null default '{}'::jsonb,
  resolved boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_integration_errors_workspace_created
  on public.integration_errors(workspace_id, created_at desc);

alter table public.integration_errors enable row level security;
revoke all on public.integration_errors from anon;
grant select, update on public.integration_errors to authenticated;
grant all on public.integration_errors to service_role;

drop policy if exists integration_errors_select_member on public.integration_errors;
create policy integration_errors_select_member
on public.integration_errors
for select
to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists integration_errors_update_member on public.integration_errors;
create policy integration_errors_update_member
on public.integration_errors
for update
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

-- 5. Update record_call_outcome_and_follow_up to:
--    - Use vobiz_live / vobiz_mock provider names
--    - Preserve any earlier qualification (HOT, WARM, COLD) on unanswered attempts
--    - Cancel queued call_queue_jobs immediately on opt-out
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

  if v_attempt_id is null and (v_lead.do_not_call or v_suppressed) then
    raise exception 'Call blocked: lead % (%) has opted out (DO_NOT_CALL suppression active)',
      v_lead.full_name, v_lead.phone_e164
      using errcode = 'P0001';
  end if;

  if p_opt_out or p_call_outcome = 'DO_NOT_CALL' then
    v_applied_temp := case
      when p_proposed_temperature in ('HOT', 'WARM', 'COLD', 'UNQUALIFIED') then p_proposed_temperature
      else v_lead.lead_temperature
    end;
    v_status := 'COMPLETED';
  elsif p_call_outcome in ('NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL') then
    -- Unanswered attempt MUST preserve any earlier qualification (HOT, WARM, or COLD)
    v_applied_temp := case
      when v_lead.lead_temperature in ('HOT', 'WARM', 'COLD') then v_lead.lead_temperature
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
      case when v_workspace.telephony_mode = 'live' then 'vobiz_live' else 'vobiz_mock' end,
      'vobiz-mock-' || replace(v_attempt_id::text, '-', ''),
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

    -- Cancel any queued calls for this lead immediately
    update public.call_queue_jobs
    set status = 'CANCELLED',
        last_error = 'Cancelled due to opt-out / DO_NOT_CALL'
    where workspace_id = p_workspace_id
      and lead_id = p_lead_id
      and status in ('PENDING', 'CLAIMED', 'DIALING', 'RECONCILING');
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

  -- Complete any claimed/dialing queue job for this attempt
  update public.call_queue_jobs
  set status = 'COMPLETED',
      call_attempt_id = v_attempt_id
  where workspace_id = p_workspace_id
    and lead_id = p_lead_id
    and status in ('CLAIMED', 'DIALING', 'RECONCILING');

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

-- 6. Ensure DigiAnchorZ workspace pilot allowlist includes all 5 live-test contacts
update public.workspaces
set allowlist_phones = array[
  '+916383939949',
  '+918754921159',
  '+919445581778',
  '+917708844146',
  '+919952823176'
]
where slug = 'digianchorz';
