import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  buildRecordOutcomeInputFromSimulation,
  simulateOutboundCallWithNila,
} from '@/lib/telephony/mock-provider';
import { parseBootstrapArgs } from '../scripts/bootstrap-founder';
import {
  DEFAULT_GOOGLE_SHEET_ID,
  DEFAULT_VOICE_AGENT_NAME,
  getRuntimeEnv,
} from '@/lib/env';

const FOUNDER_USER_ID = '11111111-1111-4111-8111-111111111111';
const FOUNDER_EMAIL = 'founder@digianchorz.com';
const OUTSIDER_USER_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER_EMAIL = 'outsider@external.org';

const MIGRATION_FILES = [
  '20261112000100_workspaces_and_members.sql',
  '20261112000200_leads_and_call_attempts.sql',
  '20261112000300_follow_up_tasks.sql',
  '20261112000400_lead_suppressions_and_sheet_sync_jobs.sql',
];

describe('DigiAnchorZ Voice · Supabase CRM Migrations, RLS & Mock Nila Qualification', () => {
  let db: PGlite;
  let digiWorkspaceId: string;
  let syntheticLeadId: string;
  let hotCallAttemptId: string;

  /**
   * Helper to run SQL inside a transaction as an authenticated Supabase user (`ROLE authenticated`)
   * with `request.jwt.claim.sub` set so `auth.uid()` and all RLS policies evaluate realistically.
   */
  async function runAsAuthenticatedUser<T>(
    userId: string,
    fn: (tx: PGlite) => Promise<T>
  ): Promise<T> {
    await db.exec('BEGIN');
    try {
      await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await db.exec(`SET LOCAL ROLE authenticated`);
      const result = await fn(db);
      await db.exec('COMMIT');
      return result;
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    db = new PGlite();

    const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
    for (const filename of MIGRATION_FILES) {
      const fullPath = path.join(migrationsDir, filename);
      expect(fs.existsSync(fullPath)).toBe(true);
      const sql = fs.readFileSync(fullPath, 'utf8');
      await db.exec(sql);
    }

    // Seed two existing Supabase Auth users in auth.users
    await db.query(
      `INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)`,
      [FOUNDER_USER_ID, FOUNDER_EMAIL, OUTSIDER_USER_ID, OUTSIDER_EMAIL]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('enables Row Level Security on all 7 exposed CRM tables and configures env defaults', async () => {
    const env = getRuntimeEnv();
    expect(env.voiceAgentName).toBe(DEFAULT_VOICE_AGENT_NAME);
    expect(env.googleSheetId).toBe(DEFAULT_GOOGLE_SHEET_ID);
    expect(env.telephonyProviderMode).toBe('mock');

    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'workspaces',
          'workspace_members',
          'leads',
          'call_attempts',
          'follow_up_tasks',
          'lead_suppressions',
          'sheet_sync_jobs'
        )
      ORDER BY c.relname;
    `);

    expect(res.rows).toHaveLength(7);
    for (const row of res.rows) {
      expect(row.relrowsecurity).toBe(true);
    }
  });

  it('bootstraps an existing Supabase Auth user ID as owner of DigiAnchorZ workspace and seeds the synthetic test lead', async () => {
    const parsedArgs = parseBootstrapArgs([
      'node',
      'scripts/bootstrap-founder.ts',
      FOUNDER_USER_ID,
      FOUNDER_EMAIL,
    ]);
    expect(parsedArgs.userId).toBe(FOUNDER_USER_ID);
    expect(parsedArgs.email).toBe(FOUNDER_EMAIL);

    const bootstrapRes = await db.query<{ result: Record<string, string> }>(
      `SELECT public.bootstrap_digianchorz_founder($1::uuid, $2::text) AS result`,
      [FOUNDER_USER_ID, FOUNDER_EMAIL]
    );

    const payload = bootstrapRes.rows[0].result;
    expect(payload.workspace_slug).toBe('digianchorz');
    expect(payload.workspace_name).toBe('DigiAnchorZ');
    expect(payload.agent_name).toBe('Nila');
    expect(payload.google_sheet_id).toBe('1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A');
    expect(payload.owner_user_id).toBe(FOUNDER_USER_ID);
    expect(payload.synthetic_external_lead_id).toBe('DAZ-SYNTH-LEAD-001');

    digiWorkspaceId = payload.workspace_id;
    syntheticLeadId = payload.synthetic_lead_id;
  });

  it('allows the signed-in founder to view the synthetic test lead, save a HOT call outcome with Agent Nila, and create exactly one callback task', async () => {
    await runAsAuthenticatedUser(FOUNDER_USER_ID, async (tx) => {
      // 1. Founder views the synthetic test lead
      const leadsRes = await tx.query<{
        id: string;
        workspace_id: string;
        external_lead_id: string;
        full_name: string;
        phone_e164: string;
        service_interest: string;
        lead_temperature: string;
      }>(`SELECT * FROM public.leads WHERE workspace_id = $1`, [digiWorkspaceId]);

      expect(leadsRes.rows).toHaveLength(1);
      const testLead = leadsRes.rows[0];
      expect(testLead.id).toBe(syntheticLeadId);
      expect(testLead.external_lead_id).toBe('DAZ-SYNTH-LEAD-001');
      expect(testLead.full_name).toBe('Karthik Subramanian');
      expect(testLead.lead_temperature).toBe('UNQUALIFIED');

      // 2. Simulate mock outbound call with Agent Nila -> HOT outcome
      const sim = simulateOutboundCallWithNila(testLead, 'HOT_CALLBACK', 'Nila');
      expect(sim.agentName).toBe('Nila');
      expect(sim.proposedTemperature).toBe('HOT');
      expect(sim.callOutcome).toBe('CALLBACK_REQUESTED');
      expect(sim.callbackAt).toBeTruthy();

      const input = buildRecordOutcomeInputFromSimulation(testLead, sim);

      const outcomeRes = await tx.query<{
        result: {
          workspace_id: string;
          lead_id: string;
          call_attempt_id: string;
          follow_up_task_id: string;
          sheet_sync_job_id: string;
          applied_temperature: string;
          call_outcome: string;
        };
      }>(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          $7::timestamptz, $8::boolean, $9::uuid, $10::jsonb, $11::integer
        ) AS result`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          input.callbackAt,
          Boolean(input.optOut),
          null,
          JSON.stringify(input.structuredExtraction ?? {}),
          input.durationSeconds ?? 118,
        ]
      );

      const recorded = outcomeRes.rows[0].result;
      expect(recorded.applied_temperature).toBe('HOT');
      expect(recorded.call_outcome).toBe('CALLBACK_REQUESTED');
      expect(recorded.follow_up_task_id).toBeTruthy();
      expect(recorded.sheet_sync_job_id).toBeTruthy();
      hotCallAttemptId = recorded.call_attempt_id;

      // 3. Re-invoke for the same call attempt to verify idempotency (still creates ONLY ONE task)
      await tx.query(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          $7::timestamptz, $8::boolean, $9::uuid, $10::jsonb, $11::integer
        )`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          input.callbackAt,
          Boolean(input.optOut),
          hotCallAttemptId,
          JSON.stringify(input.structuredExtraction ?? {}),
          input.durationSeconds ?? 118,
        ]
      );

      // 4. Verify lead is now HOT and has 1 call attempt and 1 open callback task
      const updatedLead = await tx.query<{
        lead_temperature: string;
        latest_call_outcome: string;
        attempts_count: number;
      }>(`SELECT lead_temperature, latest_call_outcome, attempts_count FROM public.leads WHERE id = $1`, [
        syntheticLeadId,
      ]);
      expect(updatedLead.rows[0].lead_temperature).toBe('HOT');
      expect(updatedLead.rows[0].latest_call_outcome).toBe('CALLBACK_REQUESTED');
      expect(updatedLead.rows[0].attempts_count).toBe(1);

      const tasksRes = await tx.query<{
        id: string;
        workspace_id: string;
        lead_id: string;
        source_call_attempt_id: string;
        status: string;
      }>(`SELECT * FROM public.follow_up_tasks WHERE workspace_id = $1 AND lead_id = $2`, [
        digiWorkspaceId,
        syntheticLeadId,
      ]);

      expect(tasksRes.rows).toHaveLength(1);
      expect(tasksRes.rows[0].source_call_attempt_id).toBe(hotCallAttemptId);
      expect(tasksRes.rows[0].status).toBe('OPEN');

      // 5. Verify server-side sheet_sync_jobs record was created and is readable by workspace member
      const syncJobsRes = await tx.query<{
        id: string;
        sheet_id: string;
        status: string;
      }>(`SELECT id, sheet_id, status FROM public.sheet_sync_jobs WHERE workspace_id = $1`, [
        digiWorkspaceId,
      ]);
      expect(syncJobsRes.rows).toHaveLength(1);
      expect(syncJobsRes.rows[0].sheet_id).toBe('1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A');
      expect(syncJobsRes.rows[0].status).toBe('PENDING');
    });
  });

  it('prevents an authenticated user outside the workspace from reading or mutating DigiAnchorZ leads, tasks, or calls', async () => {
    await runAsAuthenticatedUser(OUTSIDER_USER_ID, async (tx) => {
      const workspacesRes = await tx.query(
        `SELECT * FROM public.workspaces WHERE id = $1`,
        [digiWorkspaceId]
      );
      expect(workspacesRes.rows).toHaveLength(0);

      const leadsRes = await tx.query(
        `SELECT * FROM public.leads WHERE workspace_id = $1`,
        [digiWorkspaceId]
      );
      expect(leadsRes.rows).toHaveLength(0);

      const tasksRes = await tx.query(
        `SELECT * FROM public.follow_up_tasks WHERE workspace_id = $1`,
        [digiWorkspaceId]
      );
      expect(tasksRes.rows).toHaveLength(0);

      const callsRes = await tx.query(
        `SELECT * FROM public.call_attempts WHERE workspace_id = $1`,
        [digiWorkspaceId]
      );
      expect(callsRes.rows).toHaveLength(0);

      const syncJobsRes = await tx.query(
        `SELECT * FROM public.sheet_sync_jobs WHERE workspace_id = $1`,
        [digiWorkspaceId]
      );
      expect(syncJobsRes.rows).toHaveLength(0);

      // Attempting to call the outcome RPC for DigiAnchorZ workspace as outsider is denied
      await expect(
        tx.query(
          `SELECT public.record_call_outcome_and_follow_up(
            $1::uuid, $2::uuid, 'CONNECTED', 'HOT', 'Unauthorized attempt', 'Summary', now(), false
          )`,
          [digiWorkspaceId, syntheticLeadId]
        )
      ).rejects.toThrow(/Access denied/i);
    });
  });

  it('enforces same-workspace composite foreign keys and keeps background job writes strictly server-side', async () => {
    // 1. Direct client INSERT into sheet_sync_jobs as authenticated founder must fail (writes are server-side only)
    await expect(
      runAsAuthenticatedUser(FOUNDER_USER_ID, async (tx) => {
        await tx.query(
          `INSERT INTO public.sheet_sync_jobs (workspace_id, lead_id, idempotency_key)
           VALUES ($1, $2, 'client-forged-job')`,
          [digiWorkspaceId, syntheticLeadId]
        );
      })
    ).rejects.toThrow(/permission denied for table sheet_sync_jobs/i);

    // 2. Create a second workspace and verify related records cannot link across workspaces
    const otherWsRes = await db.query<{ id: string }>(
      `INSERT INTO public.workspaces (slug, name) VALUES ('other-tenant', 'Other Tenant') RETURNING id`
    );
    const otherWorkspaceId = otherWsRes.rows[0].id;

    // Attempting to create a follow_up_task in otherWorkspaceId referencing DigiAnchorZ's syntheticLeadId must fail
    await expect(
      db.query(
        `INSERT INTO public.follow_up_tasks (
          workspace_id, lead_id, title, due_at
        ) VALUES ($1, $2, 'Cross-tenant leak test', now())`,
        [otherWorkspaceId, syntheticLeadId]
      )
    ).rejects.toThrow(/follow_up_tasks_lead_workspace_fk/i);
  });
});

