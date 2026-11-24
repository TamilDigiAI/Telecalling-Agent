import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CallAttempt,
  CallQueueJob,
  FollowUpTask,
  FollowUpTaskStatus,
  FollowUpTaskType,
  IntegrationErrorRecord,
  Lead,
  LeadSuppression,
  LeadTemperature,
  RecordCallOutcomeInput,
  RecordCallOutcomeResult,
  SheetSyncJob,
} from '@/types/crm';

export interface WorkspaceOverviewStats {
  totalLeads: number;
  hotLeads: number;
  warmLeads: number;
  openCallbacks: number;
  pendingSheetSyncs: number;
  failedSheetSyncs: number;
  activeSuppressions: number;
}

export async function getWorkspaceOverview(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<WorkspaceOverviewStats> {
  const [leadsRes, tasksRes, syncRes, suppressionsRes] = await Promise.all([
    supabase
      .from('leads')
      .select('id, lead_temperature, sync_status')
      .eq('workspace_id', workspaceId),
    supabase
      .from('follow_up_tasks')
      .select('id, status')
      .eq('workspace_id', workspaceId)
      .eq('status', 'OPEN'),
    supabase
      .from('sheet_sync_jobs')
      .select('id, status')
      .eq('workspace_id', workspaceId),
    supabase
      .from('lead_suppressions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('active', true),
  ]);

  if (leadsRes.error) throw leadsRes.error;
  if (tasksRes.error) throw tasksRes.error;
  if (syncRes.error) throw syncRes.error;
  if (suppressionsRes.error) throw suppressionsRes.error;

  const leads = leadsRes.data ?? [];
  const syncJobs = syncRes.data ?? [];

  return {
    totalLeads: leads.length,
    hotLeads: leads.filter((l) => l.lead_temperature === 'HOT').length,
    warmLeads: leads.filter((l) => l.lead_temperature === 'WARM').length,
    openCallbacks: (tasksRes.data ?? []).length,
    pendingSheetSyncs: syncJobs.filter((j) => j.status === 'PENDING' || j.status === 'PROCESSING')
      .length,
    failedSheetSyncs: syncJobs.filter((j) => j.status === 'FAILED' || j.status === 'DEAD_LETTER')
      .length,
    activeSuppressions: (suppressionsRes.data ?? []).length,
  };
}

export async function listWorkspaceLeads(
  supabase: SupabaseClient,
  workspaceId: string,
  options?: { temperature?: LeadTemperature; search?: string }
): Promise<Lead[]> {
  let query = supabase
    .from('leads')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (options?.temperature) {
    query = query.eq('lead_temperature', options.temperature);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Lead[];
  if (options?.search?.trim()) {
    const q = options.search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        r.phone_e164.toLowerCase().includes(q) ||
        r.external_lead_id.toLowerCase().includes(q) ||
        r.service_interest.toLowerCase().includes(q)
    );
  }
  return rows;
}

export async function getWorkspaceLeadById(
  supabase: SupabaseClient,
  workspaceId: string,
  leadId: string
): Promise<Lead | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', leadId)
    .maybeSingle();

  if (error) throw error;
  return (data as Lead | null) ?? null;
}

export async function listWorkspaceCallAttempts(
  supabase: SupabaseClient,
  workspaceId: string,
  leadId?: string
): Promise<CallAttempt[]> {
  let query = supabase
    .from('call_attempts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('started_at', { ascending: false });

  if (leadId) {
    query = query.eq('lead_id', leadId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CallAttempt[];
}

export async function listWorkspaceFollowUpTasks(
  supabase: SupabaseClient,
  workspaceId: string,
  statusFilter?: FollowUpTaskStatus
): Promise<FollowUpTask[]> {
  let query = supabase
    .from('follow_up_tasks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('due_at', { ascending: true });

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as FollowUpTask[];
}

export async function listWorkspaceSuppressions(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<LeadSuppression[]> {
  const { data, error } = await supabase
    .from('lead_suppressions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as LeadSuppression[];
}

export async function listWorkspaceSheetSyncJobs(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<SheetSyncJob[]> {
  const { data, error } = await supabase
    .from('sheet_sync_jobs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as SheetSyncJob[];
}

export async function listWorkspaceCallQueueJobs(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<CallQueueJob[]> {
  const { data, error } = await supabase
    .from('call_queue_jobs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) return [];
  return (data ?? []) as CallQueueJob[];
}

export async function listWorkspaceIntegrationErrors(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<IntegrationErrorRecord[]> {
  const { data, error } = await supabase
    .from('integration_errors')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) return [];
  return (data ?? []) as IntegrationErrorRecord[];
}

/**
 * Atomically records a call outcome, updates the lead qualification in the workspace,
 * creates/upserts at most ONE callback task in follow_up_tasks, and enqueues a server-side
 * sheet_sync_jobs outbox item via the Postgres RPC `record_call_outcome_and_follow_up`.
 */
export async function recordCallOutcomeAndFollowUp(
  supabase: SupabaseClient,
  input: RecordCallOutcomeInput
): Promise<RecordCallOutcomeResult> {
  const { data, error } = await supabase.rpc('record_call_outcome_and_follow_up', {
    p_workspace_id: input.workspaceId,
    p_lead_id: input.leadId,
    p_call_outcome: input.callOutcome,
    p_proposed_temperature: input.proposedTemperature,
    p_qualification_reason: input.qualificationReason,
    p_summary: input.summary,
    p_callback_at: input.callbackAt ?? null,
    p_opt_out: Boolean(input.optOut),
    p_call_attempt_id: input.callAttemptId ?? null,
    p_structured_extraction: input.structuredExtraction ?? {},
    p_duration_seconds: input.durationSeconds ?? 95,
  });

  if (error) throw error;
  return data as RecordCallOutcomeResult;
}

export async function createFollowUpTask(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    leadId: string;
    userId: string;
    title: string;
    notes?: string;
    dueAt: string;
    taskType?: FollowUpTaskType;
    sourceCallAttemptId?: string | null;
    idempotencyKey?: string;
  }
): Promise<FollowUpTask> {
  const payload = {
    workspace_id: params.workspaceId,
    lead_id: params.leadId,
    assigned_to_user_id: params.userId,
    created_by_user_id: params.userId,
    task_type: params.taskType ?? 'FOUNDER_CALLBACK',
    title: params.title,
    notes: params.notes ?? null,
    due_at: params.dueAt,
    status: 'OPEN' as const,
    source_call_attempt_id: params.sourceCallAttemptId ?? null,
    idempotency_key: params.idempotencyKey ?? null,
  };

  const query = params.sourceCallAttemptId
    ? supabase
        .from('follow_up_tasks')
        .upsert(payload, { onConflict: 'workspace_id,source_call_attempt_id' })
    : params.idempotencyKey
      ? supabase
          .from('follow_up_tasks')
          .upsert(payload, { onConflict: 'workspace_id,idempotency_key' })
      : supabase.from('follow_up_tasks').insert(payload);

  const { data, error } = await query.select('*').single();
  if (error) throw error;
  return data as FollowUpTask;
}

export async function completeFollowUpTask(
  supabase: SupabaseClient,
  workspaceId: string,
  taskId: string
): Promise<FollowUpTask> {
  const { data, error } = await supabase
    .from('follow_up_tasks')
    .update({
      status: 'COMPLETED',
      completed_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId)
    .eq('id', taskId)
    .select('*')
    .single();

  if (error) throw error;
  return data as FollowUpTask;
}

export async function generateFounderTanglishBriefing(
  supabase: SupabaseClient,
  workspaceId: string,
  agentName = 'Nila'
): Promise<{
  tanglishText: string;
  hotLeads: Lead[];
  openTasks: FollowUpTask[];
}> {
  const [hotLeads, openTasks] = await Promise.all([
    listWorkspaceLeads(supabase, workspaceId, { temperature: 'HOT' }),
    listWorkspaceFollowUpTasks(supabase, workspaceId, 'OPEN'),
  ]);

  const topLead = hotLeads[0];
  const tanglishText =
    hotLeads.length > 0
      ? `Vanakkam Founder! Naan ${agentName} pesuren. Innaiku ${hotLeads.length} HOT lead(s) irukkaanga matrum ${openTasks.length} callback task(s) due-la irukku. ${topLead ? `${topLead.full_name} (${topLead.service_interest}) founder callback-ku confirm pannirukkaanga.` : ''}`
      : `Vanakkam Founder! Naan ${agentName} pesuren. Ippo HOT leads edhuvum illai, ${openTasks.length} follow-up task(s) open-la irukku. Test lead-ku mock call run panni qualify pannalaama?`;

  return {
    tanglishText,
    hotLeads,
    openTasks,
  };
}

