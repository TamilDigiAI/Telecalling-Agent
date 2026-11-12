import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  DEFAULT_GOOGLE_SHEET_ID,
  DEFAULT_GOOGLE_SHEET_URL,
  DEFAULT_VOICE_AGENT_NAME,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from '@/lib/env';
import { DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS } from '@/lib/knowledge/business-settings';
import type {
  CallAttempt,
  FollowUpTask,
  Lead,
  LeadSuppression,
  SheetSyncJob,
  Workspace,
  WorkspaceMember,
} from '@/types/crm';

export const PILOT_FOUNDER_COOKIE_NAME = 'daz_pilot_founder_session';
export const PILOT_FOUNDER_USER_ID = '30f1dac0-686d-47f4-94f3-acd3d55cc0ed';
export const PILOT_WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
export const PILOT_SYNTHETIC_LEAD_ID = '20000000-0000-4000-8000-000000000001';

interface LocalPilotStore {
  workspaces: Workspace[];
  workspace_members: WorkspaceMember[];
  leads: Lead[];
  call_attempts: CallAttempt[];
  follow_up_tasks: FollowUpTask[];
  lead_suppressions: LeadSuppression[];
  sheet_sync_jobs: SheetSyncJob[];
}

const globalForPilot = globalThis as unknown as {
  __dazLocalPilotStore?: LocalPilotStore;
};

function generateUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Edge-runtime compatible deterministic tag (no node:crypto or Buffer required).
 */
function computeEdgeSafeTag(input: string, secret: string): string {
  const combined = `${secret}::${input}::digianchorz`;
  let h1 = 0xdeadbeef ^ combined.length;
  let h2 = 0x41c6ce57 ^ combined.length;
  for (let i = 0; i < combined.length; i++) {
    const ch = combined.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

const PILOT_COOKIE_SECRET = 'daz-local-pilot-cookie-secret-v1';

export function createPilotFounderCookieValue(email: string): string {
  const normalizedEmail = (email || 'pheonixtamil2025@gmail.com').toLowerCase().trim();
  const payload = `${PILOT_FOUNDER_USER_ID}:${normalizedEmail}`;
  const tag = computeEdgeSafeTag(payload, PILOT_COOKIE_SECRET);
  return `${PILOT_FOUNDER_USER_ID}.${tag}`;
}

export function verifyPilotFounderCookieValue(cookieVal?: string | null): User | null {
  if (!cookieVal) return null;
  try {
    const decoded = decodeURIComponent(cookieVal).trim();
    if (!decoded.startsWith(PILOT_FOUNDER_USER_ID)) {
      return null;
    }
    return {
      id: PILOT_FOUNDER_USER_ID,
      email: 'pheonixtamil2025@gmail.com',
      app_metadata: {},
      user_metadata: { full_name: 'Tamilselvan Marimuthu' },
      aud: 'authenticated',
      created_at: '2026-11-12T00:00:00.000Z',
    } as User;
  } catch {
    return null;
  }
}

function buildInitialPilotBusinessProfile(): Record<string, unknown> {
  const base = JSON.parse(
    JSON.stringify(DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS)
  ) as typeof DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS;
  base.founder_settings = {
    approved_service_fees:
      'Custom scope-based quote prepared after understanding business goal, campaign scope, and monthly ad spend (agency management fee is distinct from ad spend).',
    minimum_ad_budget:
      'Tailored to industry and target location during the founder strategy call; ad spend is paid directly to Meta/Google platforms.',
    discovery_call_fee_policy:
      'Free 15-minute 1-on-1 discovery & audit call with Founder Tamilselvan Marimuthu.',
    callback_schedule:
      'Monday to Saturday, 10:00 AM to 7:00 PM IST (15-minute founder callback slots).',
    escalation_contacts:
      'Tamilselvan Marimuthu (Founder & MD, DigiAnchorZ · +916383939949) for Meta Ads, Google Ads, SEO, Website, WhatsApp/CRM Automation & Branding.',
    approved_proof_points:
      'AI-driven digital marketing and WhatsApp/CRM lead follow-up automation built for Tamil Nadu & Pan-India businesses from Karur.',
    service_locations_and_exclusions:
      'Karur, Coimbatore, Erode, Tiruppur, Salem, Namakkal, Trichy, Madurai, Chennai & Pan-India.',
  };
  return base as unknown as Record<string, unknown>;
}

function getOrInitPilotStore(): LocalPilotStore {
  if (!globalForPilot.__dazLocalPilotStore) {
    const nowIso = new Date().toISOString();
    globalForPilot.__dazLocalPilotStore = {
      workspaces: [
        {
          id: PILOT_WORKSPACE_ID,
          slug: DEFAULT_WORKSPACE_SLUG,
          name: DEFAULT_WORKSPACE_NAME,
          timezone: 'Asia/Kolkata',
          agent_name: DEFAULT_VOICE_AGENT_NAME,
          app_mode: 'mock',
          telephony_mode: 'live',
          dial_paused: false,
          attempt_cap: 3,
          cooldown_minutes: 120,
          allowed_start_hour_ist: 9,
          allowed_end_hour_ist: 20,
          google_sheet_id: DEFAULT_GOOGLE_SHEET_ID,
          google_sheet_url: DEFAULT_GOOGLE_SHEET_URL,
          google_sheet_tab: 'Leads',
          allowlist_phones: ['+916383939949'],
          business_profile: buildInitialPilotBusinessProfile(),
          created_at: nowIso,
          updated_at: nowIso,
        },
      ],
      workspace_members: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          workspace_id: PILOT_WORKSPACE_ID,
          user_id: PILOT_FOUNDER_USER_ID,
          email: 'pheonixtamil2025@gmail.com',
          role: 'owner',
          created_at: nowIso,
          updated_at: nowIso,
        },
      ],
      leads: [
        {
          id: '20000000-0000-4000-8000-000000000002',
          workspace_id: PILOT_WORKSPACE_ID,
          external_lead_id: 'DAZ-PILOT-6383939949',
          sheet_id: DEFAULT_GOOGLE_SHEET_ID,
          sheet_tab: 'Leads',
          sheet_row_number: 1,
          full_name: 'Tamilselvan Marimuthu (Pilot Test)',
          raw_phone: '6383939949',
          phone_e164: '+916383939949',
          service_interest: 'Meta Ads for Facebook and Instagram lead generation',
          source: 'Google Sheet',
          calling_eligibility: 'ELIGIBLE',
          eligibility_reference: 'GSHEET-1X9sQhlRx-PILOT-STAFF-CONSENT',
          available_window: '09:00-20:00 IST',
          do_not_call: false,
          lead_temperature: 'UNQUALIFIED',
          latest_call_outcome: null,
          qualification_reason: null,
          call_summary: null,
          need_summary: null,
          timeline: null,
          budget_band: null,
          next_action: null,
          callback_at: null,
          last_call_at: null,
          attempts_count: 0,
          owner_user_id: PILOT_FOUNDER_USER_ID,
          sync_status: 'PENDING',
          last_synced_at: null,
          sync_error: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
        {
          id: PILOT_SYNTHETIC_LEAD_ID,
          workspace_id: PILOT_WORKSPACE_ID,
          external_lead_id: 'DAZ-SYNTH-LEAD-001',
          sheet_id: DEFAULT_GOOGLE_SHEET_ID,
          sheet_tab: 'Leads',
          sheet_row_number: 2,
          full_name: 'Karthik Subramanian',
          raw_phone: '98765 43210',
          phone_e164: '+919876543210',
          service_interest: 'Meta Ads for Facebook and Instagram lead generation',
          source: 'Google Sheet',
          calling_eligibility: 'ELIGIBLE',
          eligibility_reference: 'GSHEET-1X9sQhlRx-ROW-2-ENQUIRY-CONSENT',
          available_window: '10:00-19:00 IST',
          do_not_call: false,
          lead_temperature: 'UNQUALIFIED',
          latest_call_outcome: null,
          qualification_reason: null,
          call_summary: null,
          need_summary: null,
          timeline: null,
          budget_band: null,
          next_action: null,
          callback_at: null,
          last_call_at: null,
          attempts_count: 0,
          owner_user_id: PILOT_FOUNDER_USER_ID,
          sync_status: 'PENDING',
          last_synced_at: null,
          sync_error: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
      ],
      call_attempts: [],
      follow_up_tasks: [],
      lead_suppressions: [],
      sheet_sync_jobs: [],
    };
  }
  const store = globalForPilot.__dazLocalPilotStore!;
  const ws = store.workspaces[0];
  if (ws) {
    const bp = ws.business_profile as { founder_settings?: { callback_schedule?: string } } | undefined;
    if (!bp?.founder_settings?.callback_schedule) {
      ws.business_profile = buildInitialPilotBusinessProfile();
    }
  }
  return store;
}

class LocalQueryBuilder {
  private tableName: keyof LocalPilotStore;
  private filters: Array<(row: Record<string, unknown>) => boolean> = [];
  private pendingUpdate: Record<string, unknown> | null = null;
  private pendingInsert: Record<string, unknown> | null = null;
  private pendingUpsertConflict: string | null = null;
  private limitCount: number | null = null;

  constructor(tableName: keyof LocalPilotStore) {
    this.tableName = tableName;
  }

  select(_columns?: string) {
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  in(field: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[field]));
    return this;
  }

  order(_field: string, _opts?: { ascending?: boolean }) {
    return this;
  }

  limit(n: number) {
    this.limitCount = n;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.pendingUpdate = values;
    return this;
  }

  insert(values: Record<string, unknown>) {
    this.pendingInsert = values;
    return this;
  }

  upsert(values: Record<string, unknown>, opts?: { onConflict?: string }) {
    this.pendingInsert = values;
    this.pendingUpsertConflict = opts?.onConflict ?? null;
    return this;
  }

  private execute(): Record<string, unknown>[] {
    const store = getOrInitPilotStore();
    const list = store[this.tableName] as unknown as Record<string, unknown>[];
    const nowIso = new Date().toISOString();

    if (this.pendingInsert) {
      const item = {
        id: (this.pendingInsert.id as string) || generateUuid(),
        created_at: nowIso,
        updated_at: nowIso,
        ...this.pendingInsert,
      };
      if (this.pendingUpsertConflict) {
        const keys = this.pendingUpsertConflict.split(',').map((k) => k.trim());
        const existingIdx = list.findIndex((r) =>
          keys.every((k) => r[k] && r[k] === (item as Record<string, unknown>)[k])
        );
        if (existingIdx >= 0) {
          list[existingIdx] = { ...list[existingIdx], ...item, updated_at: nowIso };
          return [list[existingIdx]];
        }
      }
      list.unshift(item);
      return [item];
    }

    const matched = list.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.pendingUpdate) {
      for (const row of matched) {
        Object.assign(row, this.pendingUpdate, { updated_at: nowIso });
      }
    }
    return this.limitCount ? matched.slice(0, this.limitCount) : matched;
  }

  async maybeSingle() {
    const rows = this.execute();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const rows = this.execute();
    return { data: rows[0] ?? null, error: rows[0] ? null : new Error('Row not found') };
  }

  then<TResult1 = { data: Record<string, unknown>[]; error: null }>(
    onfulfilled?:
      | ((value: {
          data: Record<string, unknown>[];
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null
  ): Promise<TResult1> {
    const rows = this.execute();
    return Promise.resolve({ data: rows, error: null }).then(onfulfilled);
  }
}

export function createLocalPilotSupabaseClient(user: User): SupabaseClient {
  const store = getOrInitPilotStore();

  const client = {
    auth: {
      async getUser() {
        return { data: { user }, error: null };
      },
    },
    from(table: keyof LocalPilotStore) {
      return new LocalQueryBuilder(table);
    },
    async rpc(fnName: string, args: Record<string, unknown>) {
      const nowIso = new Date().toISOString();
      if (fnName === 'update_workspace_business_settings') {
        const ws = store.workspaces.find((w) => w.id === args.p_workspace_id);
        if (!ws) return { data: null, error: new Error('Workspace not found') };
        ws.business_profile = args.p_business_profile as Record<string, unknown>;
        ws.updated_at = nowIso;
        return { data: ws.business_profile, error: null };
      }

      if (fnName === 'record_call_outcome_and_follow_up') {
        const lead = store.leads.find(
          (l) => l.id === args.p_lead_id && l.workspace_id === args.p_workspace_id
        );
        if (!lead) return { data: null, error: new Error('Lead not found') };
        if (lead.do_not_call && !args.p_call_attempt_id) {
          return {
            data: null,
            error: new Error(
              `Call blocked: lead ${lead.full_name} (${lead.phone_e164}) has opted out (DO_NOT_CALL suppression active)`
            ),
          };
        }

        const attemptId = (args.p_call_attempt_id as string) || generateUuid();
        const callOutcome = args.p_call_outcome as CallAttempt['call_outcome'];
        const proposedTemp = args.p_proposed_temperature as Lead['lead_temperature'];
        const optOut = Boolean(args.p_opt_out) || callOutcome === 'DO_NOT_CALL';

        let appliedTemp: Lead['lead_temperature'] = proposedTemp || 'UNQUALIFIED';
        if (
          callOutcome &&
          ['NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL'].includes(callOutcome)
        ) {
          appliedTemp =
            lead.lead_temperature === 'HOT' || lead.lead_temperature === 'WARM'
              ? lead.lead_temperature
              : 'UNQUALIFIED';
        }

        const attempt: CallAttempt = {
          id: attemptId,
          workspace_id: lead.workspace_id,
          lead_id: lead.id,
          attempt_number: lead.attempts_count + 1,
          agent_name: 'Nila',
          provider: 'exotel_mock',
          provider_call_sid: `mock-exo-${attemptId.slice(0, 8)}`,
          direction: 'OUTBOUND',
          status: 'COMPLETED',
          call_outcome: callOutcome,
          proposed_temperature: proposedTemp,
          applied_temperature: appliedTemp,
          qualification_reason: (args.p_qualification_reason as string) || null,
          summary: (args.p_summary as string) || null,
          structured_extraction:
            (args.p_structured_extraction as Record<string, unknown>) || {},
          opt_out_requested: optOut,
          callback_requested_at: (args.p_callback_at as string) || null,
          duration_seconds: Number(args.p_duration_seconds ?? 95),
          initiated_by_user_id: user.id,
          started_at: nowIso,
          ended_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        };
        store.call_attempts.unshift(attempt);

        lead.lead_temperature = appliedTemp;
        lead.latest_call_outcome = callOutcome;
        lead.qualification_reason = attempt.qualification_reason;
        lead.call_summary = attempt.summary;
        lead.callback_at = attempt.callback_requested_at ?? lead.callback_at;
        lead.last_call_at = nowIso;
        lead.attempts_count += 1;
        lead.do_not_call = lead.do_not_call || optOut;
        lead.sync_status = 'PENDING';
        lead.updated_at = nowIso;

        let taskId: string | null = null;
        if (optOut) {
          store.lead_suppressions.unshift({
            id: generateUuid(),
            workspace_id: lead.workspace_id,
            lead_id: lead.id,
            source_call_attempt_id: attemptId,
            phone_e164: lead.phone_e164,
            reason: 'USER_OPT_OUT',
            notes: attempt.summary,
            suppressed_by_user_id: user.id,
            active: true,
            created_at: nowIso,
            updated_at: nowIso,
          });
        } else if (args.p_callback_at) {
          const existingTask = store.follow_up_tasks.find(
            (t) =>
              t.workspace_id === lead.workspace_id && t.source_call_attempt_id === attemptId
          );
          if (existingTask) {
            existingTask.due_at = args.p_callback_at as string;
            taskId = existingTask.id;
          } else {
            const newTask: FollowUpTask = {
              id: generateUuid(),
              workspace_id: lead.workspace_id,
              lead_id: lead.id,
              source_call_attempt_id: attemptId,
              assigned_to_user_id: user.id,
              created_by_user_id: user.id,
              task_type: 'FOUNDER_CALLBACK',
              title: `Founder callback: ${lead.full_name} (${lead.service_interest})`,
              notes: attempt.summary,
              due_at: args.p_callback_at as string,
              status: 'OPEN',
              completed_at: null,
              idempotency_key: `attempt-callback:${attemptId}`,
              created_at: nowIso,
              updated_at: nowIso,
            };
            store.follow_up_tasks.unshift(newTask);
            taskId = newTask.id;
          }
        }

        const syncJobId = generateUuid();
        store.sheet_sync_jobs.unshift({
          id: syncJobId,
          workspace_id: lead.workspace_id,
          lead_id: lead.id,
          call_attempt_id: attemptId,
          sheet_id: lead.sheet_id,
          sheet_tab: lead.sheet_tab,
          sheet_row_number: lead.sheet_row_number,
          operation: optOut ? 'WRITE_BACK_OPT_OUT' : 'WRITE_BACK_OUTCOME',
          status: 'PENDING',
          payload: {
            crm_lead_id: lead.id,
            call_outcome: callOutcome,
            lead_temperature: appliedTemp,
          },
          attempts: 0,
          max_attempts: 5,
          locked_by: null,
          lease_expires_at: null,
          next_attempt_at: nowIso,
          last_error: null,
          completed_at: null,
          idempotency_key: `sheet-sync:attempt:${attemptId}`,
          created_at: nowIso,
          updated_at: nowIso,
        });

        return {
          data: {
            workspace_id: lead.workspace_id,
            lead_id: lead.id,
            call_attempt_id: attemptId,
            follow_up_task_id: taskId,
            sheet_sync_job_id: syncJobId,
            applied_temperature: appliedTemp,
            call_outcome: callOutcome,
            slot_verified: false,
          },
          error: null,
        };
      }

      return { data: null, error: null };
    },
  };

  return client as unknown as SupabaseClient;
}
