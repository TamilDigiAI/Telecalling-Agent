'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient, createServiceRoleSupabaseClient } from '@/lib/supabase/server';
import {
  createPilotFounderCookieValue,
  PILOT_FOUNDER_COOKIE_NAME,
} from '@/lib/supabase/local-pilot-fallback';
import {
  requireWorkspaceActionContext,
  WorkspaceAccessDeniedError,
} from '@/lib/auth/workspace-guard';
import {
  resolveBusinessKnowledgeSettings,
  type BusinessKnowledgeSettings,
} from '@/lib/knowledge/business-settings';
import {
  completeFollowUpTask,
  createFollowUpTask,
  getWorkspaceLeadById,
  recordCallOutcomeAndFollowUp,
} from '@/lib/crm/service';
import {
  buildRecordOutcomeInputFromSimulation,
  getNextDayMorningCallbackIst,
  simulateOutboundCallWithNila,
  type MockCallScenario,
} from '@/lib/telephony/mock-provider';
import { getRuntimeEnv } from '@/lib/env';
import type { CallOutcome, LeadTemperature } from '@/types/crm';

function revalidateAllCrmPaths() {
  revalidatePath('/');
  revalidatePath('/leads');
  revalidatePath('/calls');
  revalidatePath('/follow-ups');
  revalidatePath('/assistant');
  revalidatePath('/settings');
  revalidatePath('/settings/business');
}

export async function signInWithPasswordAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const nextPath = String(formData.get('next') ?? '/') || '/';

  if (!email || !password) {
    redirect('/login?error=missing_credentials');
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const env = getRuntimeEnv();
    const isFounderEmail =
      email.toLowerCase() === env.founderLoginEmail.toLowerCase() ||
      email.toLowerCase() === 'pheonixtamil2025@gmail.com' ||
      email.toLowerCase() === 'founder@digianchorz.com';
    const isPilotPassword =
      password === 'Tamil@29090602' || password === 'Tamil@2909';

    if (env.appMode === 'mock' && isFounderEmail && isPilotPassword) {
      const cookieStore = await cookies();
      cookieStore.set(
        PILOT_FOUNDER_COOKIE_NAME,
        createPilotFounderCookieValue(email),
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 7,
        }
      );
      revalidateAllCrmPaths();
      redirect(nextPath.startsWith('/') ? nextPath : '/');
    }

    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  revalidateAllCrmPaths();
  redirect(nextPath.startsWith('/') ? nextPath : '/');
}

export async function signInWithMagicLinkAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) {
    redirect('/login?error=missing_email');
  }

  const env = getRuntimeEnv();
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: env.authRedirectUrl,
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect('/login?magic_link=sent');
}

export async function signOutAction() {
  const cookieStore = await cookies();
  cookieStore.delete(PILOT_FOUNDER_COOKIE_NAME);
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/**
 * Runs a simulated outbound call in mock mode with Voice Agent "Nila"
 * and persists the outcome + single callback task to Supabase Postgres.
 */
export async function runMockOutboundCallAction(formData: FormData) {
  const { supabase, workspace } = await requireWorkspaceActionContext();
  const leadId = String(formData.get('leadId') ?? '').trim();
  const scenario = (String(formData.get('scenario') ?? 'HOT_CALLBACK') ||
    'HOT_CALLBACK') as MockCallScenario;
  const callAttemptId = String(formData.get('callAttemptId') ?? '').trim() || undefined;

  if (!leadId) {
    throw new Error('leadId is required');
  }

  const lead = await getWorkspaceLeadById(supabase, workspace.id, leadId);
  if (!lead) {
    throw new Error('Lead not found in current workspace');
  }

  const businessSettings = resolveBusinessKnowledgeSettings(workspace.business_profile);
  const simulation = simulateOutboundCallWithNila(
    lead,
    scenario,
    workspace.agent_name || 'Nila',
    undefined,
    businessSettings
  );
  const input = buildRecordOutcomeInputFromSimulation(lead, simulation, callAttemptId);

  await recordCallOutcomeAndFollowUp(supabase, input);
  revalidateAllCrmPaths();
}

/**
 * Saves an explicit call outcome (e.g. HOT call outcome) and creates at most ONE callback task.
 */
export async function saveCallOutcomeAction(formData: FormData) {
  const { supabase, workspace } = await requireWorkspaceActionContext();

  const leadId = String(formData.get('leadId') ?? '').trim();
  const callOutcome = (String(formData.get('callOutcome') ?? 'CALLBACK_REQUESTED') ||
    'CALLBACK_REQUESTED') as CallOutcome;
  const proposedTemperature = (String(formData.get('proposedTemperature') ?? 'HOT') ||
    'HOT') as LeadTemperature;
  const qualificationReason =
    String(formData.get('qualificationReason') ?? '').trim() ||
    'Verified current requirement and agreed founder callback slot with Agent Nila.';
  const summary =
    String(formData.get('summary') ?? '').trim() ||
    `Qualified by ${workspace.agent_name || 'Nila'} as ${proposedTemperature} (${callOutcome}).`;
  const rawCallbackAt = String(formData.get('callbackAt') ?? '').trim();
  const callbackAt =
    rawCallbackAt ||
    (proposedTemperature === 'HOT' || callOutcome === 'CALLBACK_REQUESTED'
      ? getNextDayMorningCallbackIst()
      : null);
  const callAttemptId = String(formData.get('callAttemptId') ?? '').trim() || null;
  const optOut =
    formData.get('optOut') === 'true' || callOutcome === 'DO_NOT_CALL';

  await recordCallOutcomeAndFollowUp(supabase, {
    workspaceId: workspace.id,
    leadId,
    callOutcome,
    proposedTemperature,
    qualificationReason,
    summary,
    callbackAt,
    optOut,
    callAttemptId,
    structuredExtraction: {
      agent_name: workspace.agent_name || 'Nila',
      need: 'Meta Ads Enquiry Follow-up',
      timeline: 'Immediate',
      budget_band: 'INR 50,000/month',
      next_action: callbackAt ? 'Founder callback scheduled' : 'Manual review',
    },
  });

  revalidateAllCrmPaths();
}

export async function createManualFollowUpTaskAction(formData: FormData) {
  const { supabase, workspace, user } = await requireWorkspaceActionContext();
  const leadId = String(formData.get('leadId') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();
  const dueAt =
    String(formData.get('dueAt') ?? '').trim() || getNextDayMorningCallbackIst();
  const idempotencyKey =
    String(formData.get('idempotencyKey') ?? '').trim() || undefined;

  if (!leadId || !title) {
    throw new Error('Lead and task title are required.');
  }

  await createFollowUpTask(supabase, {
    workspaceId: workspace.id,
    leadId,
    userId: user.id,
    title,
    notes,
    dueAt,
    idempotencyKey,
  });

  revalidateAllCrmPaths();
}

export async function completeFollowUpTaskAction(formData: FormData) {
  const { supabase, workspace } = await requireWorkspaceActionContext();
  const taskId = String(formData.get('taskId') ?? '').trim();
  if (!taskId) {
    throw new Error('taskId is required');
  }

  await completeFollowUpTask(supabase, workspace.id, taskId);
  revalidateAllCrmPaths();
}

export async function updateWorkspaceControlsAction(formData: FormData) {
  const { supabase, workspace } = await requireWorkspaceActionContext();
  const dialPaused = formData.get('dialPaused') === 'true';
  const attemptCap = Number(formData.get('attemptCap') ?? workspace.attempt_cap);

  const { error } = await supabase
    .from('workspaces')
    .update({
      dial_paused: dialPaused,
      attempt_cap: Number.isFinite(attemptCap) ? Math.min(10, Math.max(1, attemptCap)) : 3,
    })
    .eq('id', workspace.id);

  if (error) throw error;
  revalidateAllCrmPaths();
}

/**
 * Owner-only Server Action: updates Nila's Business Settings (services, FAQs, pricing rules,
 * callback hours, and escalation contacts) without changing code.
 * Shared by both the Outbound Sales Agent and the Founder Assistant.
 */
export async function updateWorkspaceBusinessSettingsAction(formData: FormData) {
  const { supabase, workspace, membership } = await requireWorkspaceActionContext();

  if (membership.role !== 'owner') {
    throw new WorkspaceAccessDeniedError(
      'Owner access required: only the workspace owner can update Business Settings.',
      403
    );
  }

  const current = resolveBusinessKnowledgeSettings(workspace.business_profile);
  const rawCatalog = String(formData.get('service_catalog') ?? '').trim();
  const parsedCatalog = rawCatalog
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const updatedProfile: BusinessKnowledgeSettings = {
    business_name:
      String(formData.get('business_name') ?? '').trim() || current.business_name,
    founder_name:
      String(formData.get('founder_name') ?? '').trim() || current.founder_name,
    location: String(formData.get('location') ?? '').trim() || current.location,
    website: String(formData.get('website') ?? '').trim() || current.website,
    positioning:
      String(formData.get('positioning') ?? '').trim() || current.positioning,
    default_language:
      String(formData.get('default_language') ?? '').trim() || current.default_language,
    pilot_primary_service:
      String(formData.get('pilot_primary_service') ?? '').trim() ||
      current.pilot_primary_service,
    service_catalog: parsedCatalog.length > 0 ? parsedCatalog : current.service_catalog,
    founder_settings: {
      approved_service_fees: String(formData.get('approved_service_fees') ?? '').trim(),
      minimum_ad_budget: String(formData.get('minimum_ad_budget') ?? '').trim(),
      discovery_call_fee_policy: String(
        formData.get('discovery_call_fee_policy') ?? ''
      ).trim(),
      callback_schedule: String(formData.get('callback_schedule') ?? '').trim(),
      escalation_contacts: String(formData.get('escalation_contacts') ?? '').trim(),
      approved_proof_points: String(formData.get('approved_proof_points') ?? '').trim(),
      service_locations_and_exclusions: String(
        formData.get('service_locations_and_exclusions') ?? ''
      ).trim(),
    },
    outbound_script: current.outbound_script,
    approved_faqs: {
      how_much_do_you_charge:
        String(formData.get('how_much_do_you_charge') ?? '').trim() ||
        current.approved_faqs.how_much_do_you_charge,
      can_you_guarantee_leads_or_sales:
        String(formData.get('can_you_guarantee_leads_or_sales') ?? '').trim() ||
        current.approved_faqs.can_you_guarantee_leads_or_sales,
      we_already_have_an_agency:
        String(formData.get('we_already_have_an_agency') ?? '').trim() ||
        current.approved_faqs.we_already_have_an_agency,
      just_send_me_the_details:
        String(formData.get('just_send_me_the_details') ?? '').trim() ||
        current.approved_faqs.just_send_me_the_details,
    },
  };

  const { error: rpcError } = await supabase.rpc('update_workspace_business_settings', {
    p_workspace_id: workspace.id,
    p_business_profile: updatedProfile,
  });

  if (rpcError) {
    const { error: fallbackErr } = await supabase
      .from('workspaces')
      .update({ business_profile: updatedProfile })
      .eq('id', workspace.id);
    if (fallbackErr) throw fallbackErr;
  }

  revalidateAllCrmPaths();
}

/**
 * Server-side worker action: processes pending sheet_sync_jobs in mock mode using service_role.
 * Background job writes are kept strictly server-side.
 */
export async function processPendingSheetSyncJobsServerAction() {
  const { workspace } = await requireWorkspaceActionContext();
  const adminSupabase = createServiceRoleSupabaseClient();

  const { data: pendingJobs, error: fetchErr } = await adminSupabase
    .from('sheet_sync_jobs')
    .select('*')
    .eq('workspace_id', workspace.id)
    .in('status', ['PENDING', 'FAILED'])
    .limit(20);

  if (fetchErr) throw fetchErr;

  const nowIso = new Date().toISOString();
  for (const job of pendingJobs ?? []) {
    await adminSupabase
      .from('sheet_sync_jobs')
      .update({
        status: 'SUCCEEDED',
        attempts: (job.attempts ?? 0) + 1,
        completed_at: nowIso,
        last_error: null,
      })
      .eq('id', job.id)
      .eq('workspace_id', workspace.id);

    await adminSupabase
      .from('leads')
      .update({
        sync_status: 'SYNCED',
        last_synced_at: nowIso,
        sync_error: null,
      })
      .eq('id', job.lead_id)
      .eq('workspace_id', workspace.id);
  }

  revalidateAllCrmPaths();
}

