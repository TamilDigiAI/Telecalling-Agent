export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'agent';

export type LeadTemperature = 'HOT' | 'WARM' | 'COLD' | 'UNQUALIFIED';

export type CallOutcome =
  | 'CONNECTED'
  | 'CALLBACK_REQUESTED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'FAILED'
  | 'VOICEMAIL'
  | 'WRONG_NUMBER'
  | 'DO_NOT_CALL';

export type CallAttemptStatus =
  | 'QUEUED'
  | 'INITIATED'
  | 'RINGING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'FAILED'
  | 'CANCELLED';

export type CallingEligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'PENDING_REVIEW';

export type SyncStatus = 'PENDING' | 'SYNCED' | 'FAILED' | 'SKIPPED';

export type FollowUpTaskType =
  | 'FOUNDER_CALLBACK'
  | 'DEMO_FOLLOW_UP'
  | 'QUOTE_FOLLOW_UP'
  | 'MANUAL_REVIEW';

export type FollowUpTaskStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';

export type SheetSyncJobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEAD_LETTER';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  agent_name: string;
  app_mode: 'mock' | 'pilot';
  telephony_mode: 'mock' | 'live';
  dial_paused: boolean;
  attempt_cap: number;
  cooldown_minutes: number;
  allowed_start_hour_ist: number;
  allowed_end_hour_ist: number;
  google_sheet_id: string;
  google_sheet_url: string;
  google_sheet_tab: string;
  allowlist_phones: string[];
  business_profile: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  email: string | null;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  workspace_id: string;
  external_lead_id: string;
  sheet_id: string;
  sheet_tab: string;
  sheet_row_number: number | null;
  full_name: string;
  raw_phone: string;
  phone_e164: string;
  service_interest: string;
  source: string;
  calling_eligibility: CallingEligibility;
  eligibility_reference: string;
  available_window: string;
  do_not_call: boolean;
  lead_temperature: LeadTemperature;
  latest_call_outcome: CallOutcome | null;
  qualification_reason: string | null;
  call_summary: string | null;
  need_summary: string | null;
  timeline: string | null;
  budget_band: string | null;
  next_action: string | null;
  callback_at: string | null;
  last_call_at: string | null;
  attempts_count: number;
  owner_user_id: string | null;
  sync_status: SyncStatus;
  last_synced_at: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StructuredCallExtraction {
  need?: string | null;
  timeline?: string | null;
  budget_band?: string | null;
  next_action?: string | null;
  transcript_highlights?: string[];
  agent_name?: string;
  pricing_question_without_approved_rate?: boolean;
  invented_quote?: string | null;
}

export interface CallAttempt {
  id: string;
  workspace_id: string;
  lead_id: string;
  attempt_number: number;
  agent_name: string;
  provider: 'exotel_mock' | 'exotel_live';
  provider_call_sid: string | null;
  direction: 'OUTBOUND' | 'INBOUND';
  status: CallAttemptStatus;
  call_outcome: CallOutcome | null;
  proposed_temperature: LeadTemperature | null;
  applied_temperature: LeadTemperature | null;
  qualification_reason: string | null;
  summary: string | null;
  structured_extraction: StructuredCallExtraction;
  opt_out_requested: boolean;
  callback_requested_at: string | null;
  duration_seconds: number;
  initiated_by_user_id: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowUpTask {
  id: string;
  workspace_id: string;
  lead_id: string;
  source_call_attempt_id: string | null;
  assigned_to_user_id: string | null;
  created_by_user_id: string | null;
  task_type: FollowUpTaskType;
  title: string;
  notes: string | null;
  due_at: string;
  status: FollowUpTaskStatus;
  completed_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadSuppression {
  id: string;
  workspace_id: string;
  lead_id: string | null;
  source_call_attempt_id: string | null;
  phone_e164: string;
  reason: 'DO_NOT_CALL' | 'USER_OPT_OUT' | 'INVALID_NUMBER' | 'MANUAL_SUPPRESSION' | 'COMPLIANCE_BLOCK';
  notes: string | null;
  suppressed_by_user_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SheetSyncJob {
  id: string;
  workspace_id: string;
  lead_id: string;
  call_attempt_id: string | null;
  sheet_id: string;
  sheet_tab: string;
  sheet_row_number: number | null;
  operation: 'WRITE_BACK_OUTCOME' | 'WRITE_BACK_OPT_OUT' | 'MANUAL_RESYNC';
  status: SheetSyncJobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  last_error: string | null;
  completed_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface RecordCallOutcomeInput {
  workspaceId: string;
  leadId: string;
  callOutcome: CallOutcome;
  proposedTemperature: LeadTemperature;
  qualificationReason: string;
  summary: string;
  callbackAt?: string | null;
  optOut?: boolean;
  callAttemptId?: string | null;
  structuredExtraction?: StructuredCallExtraction;
  durationSeconds?: number;
}

export interface RecordCallOutcomeResult {
  workspace_id: string;
  lead_id: string;
  call_attempt_id: string;
  follow_up_task_id: string | null;
  sheet_sync_job_id: string;
  applied_temperature: LeadTemperature;
  call_outcome: CallOutcome;
  slot_verified?: boolean;
}

