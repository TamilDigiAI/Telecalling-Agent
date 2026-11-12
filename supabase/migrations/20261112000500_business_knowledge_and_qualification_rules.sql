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

