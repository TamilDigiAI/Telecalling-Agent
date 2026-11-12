import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  buildApprovedPricingReply,
  buildSharedNilaSystemPrompt,
  DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  DIGIANCHORZ_SERVICE_CATALOG,
  resolveBusinessKnowledgeSettings,
} from '@/lib/knowledge/business-settings';
import {
  buildRecordOutcomeInputFromSimulation,
  simulateOutboundCallWithNila,
} from '@/lib/telephony/mock-provider';

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_EMAIL = 'founder@digianchorz.com';
const MEMBER_USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_EMAIL = 'staff@digianchorz.com';

const MIGRATIONS = [
  '20261112000100_workspaces_and_members.sql',
  '20261112000200_leads_and_call_attempts.sql',
  '20261112000300_follow_up_tasks.sql',
  '20261112000400_lead_suppressions_and_sheet_sync_jobs.sql',
  '20261112000500_business_knowledge_and_qualification_rules.sql',
];

describe('DigiAnchorZ Voice · Business Knowledge, Owner-Only Settings & 5 Pilot Scenarios', () => {
  let db: PGlite;
  let workspaceId: string;

  async function runAsUser<T>(userId: string, fn: (tx: PGlite) => Promise<T>): Promise<T> {
    await db.exec('BEGIN');
    try {
      await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await db.exec(`SET LOCAL ROLE authenticated`);
      const res = await fn(db);
      await db.exec('COMMIT');
      return res;
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }

  async function createTestLead(
    externalId: string,
    fullName: string,
    phoneE164: string,
    service = 'Meta Ads for Facebook and Instagram lead generation'
  ): Promise<{
    id: string;
    workspace_id: string;
    full_name: string;
    service_interest: string;
    phone_e164: string;
    do_not_call: boolean;
  }> {
    const res = await db.query<{
      id: string;
      workspace_id: string;
      full_name: string;
      service_interest: string;
      phone_e164: string;
      do_not_call: boolean;
    }>(
      `INSERT INTO public.leads (
        workspace_id, external_lead_id, full_name, raw_phone, phone_e164,
        service_interest, source, calling_eligibility, eligibility_reference
      ) VALUES ($1, $2, $3, $4, $4, $5, 'Google Sheet', 'ELIGIBLE', $6)
      RETURNING id, workspace_id, full_name, service_interest, phone_e164, do_not_call`,
      [workspaceId, externalId, fullName, phoneE164, service, `REF-${externalId}`]
    );
    return res.rows[0];
  }

  beforeAll(async () => {
    db = new PGlite();
    const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
    for (const file of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await db.exec(sql);
    }

    await db.query(
      `INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)`,
      [OWNER_USER_ID, OWNER_EMAIL, MEMBER_USER_ID, MEMBER_EMAIL]
    );

    const boot = await db.query<{ result: Record<string, string> }>(
      `SELECT public.bootstrap_digianchorz_founder($1::uuid, $2::text) AS result`,
      [OWNER_USER_ID, OWNER_EMAIL]
    );
    workspaceId = boot.rows[0].result.workspace_id;

    // Re-apply migration 05 update on the newly bootstrapped workspace so it has the full default profile
    const mig05 = fs.readFileSync(
      path.join(migrationsDir, '20261112000500_business_knowledge_and_qualification_rules.sql'),
      'utf8'
    );
    await db.exec(mig05);

    // Add a non-owner staff member (role = 'admin') to verify owner-only restriction
    await db.query(
      `INSERT INTO public.workspace_members (workspace_id, user_id, email, role)
       VALUES ($1, $2, $3, 'admin')`,
      [workspaceId, MEMBER_USER_ID, MEMBER_EMAIL]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('configures DigiAnchorZ Business Profile, 6-service catalog, blank founder settings, and enforces owner-only updates', async () => {
    const wsRes = await db.query<{ business_profile: Record<string, unknown> }>(
      `SELECT business_profile FROM public.workspaces WHERE id = $1`,
      [workspaceId]
    );
    const settings = resolveBusinessKnowledgeSettings(wsRes.rows[0].business_profile);

    expect(settings.business_name).toBe('DigiAnchorZ');
    expect(settings.founder_name).toBe('Tamilselvan Marimuthu');
    expect(settings.location).toBe('Karur, Tamil Nadu');
    expect(settings.website).toBe('https://digianchorz.com');
    expect(settings.positioning).toBe('AI-driven digital marketing and automation agency.');
    expect(settings.default_language).toBe('Natural Tamil Nadu Tanglish');
    expect(settings.service_catalog).toEqual([...DIGIANCHORZ_SERVICE_CATALOG]);

    // Verify all 7 Founder Settings are blank until the founder fills them in
    expect(settings.founder_settings).toEqual({
      approved_service_fees: '',
      minimum_ad_budget: '',
      discovery_call_fee_policy: '',
      callback_schedule: '',
      escalation_contacts: '',
      approved_proof_points: '',
      service_locations_and_exclusions: '',
    });

    // Shared prompt includes both outbound sales and founder assistant context
    const salesPrompt = buildSharedNilaSystemPrompt(settings, 'outbound_sales');
    const assistantPrompt = buildSharedNilaSystemPrompt(settings, 'founder_assistant');
    expect(salesPrompt).toContain('Tamilselvan Marimuthu');
    expect(salesPrompt).toContain('enga MD தமிழ்செல்வன் sir கிட்ட ஒரு short callback arrange பண்ணலாமா?');
    expect(assistantPrompt).toContain('Authenticated Founder Assistant');

    // Non-owner ('admin') cannot update Business Settings
    await expect(
      runAsUser(MEMBER_USER_ID, async (tx) => {
        await tx.query(`SELECT public.update_workspace_business_settings($1::uuid, $2::jsonb)`, [
          workspaceId,
          JSON.stringify(settings),
        ]);
      })
    ).rejects.toThrow(/Owner access required/i);

    // Owner ('owner') CAN update Business Settings without changing code
    await runAsUser(OWNER_USER_ID, async (tx) => {
      const updated = structuredClone(settings);
      updated.founder_settings.escalation_contacts = 'Tamilselvan Marimuthu (Meta Ads & Automation)';
      const res = await tx.query<{ result: Record<string, unknown> }>(
        `SELECT public.update_workspace_business_settings($1::uuid, $2::jsonb) AS result`,
        [workspaceId, JSON.stringify(updated)]
      );
      const saved = resolveBusinessKnowledgeSettings(res.rows[0].result);
      expect(saved.founder_settings.escalation_contacts).toBe(
        'Tamilselvan Marimuthu (Meta Ads & Automation)'
      );
      // Reset back to blank for pilot scenario checks
      await tx.query(`SELECT public.update_workspace_business_settings($1::uuid, $2::jsonb)`, [
        workspaceId,
        JSON.stringify(DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS),
      ]);
    });
  });

  it('Scenario 1: Meta Ads enquiry with a current need and an agreed callback becomes HOT', async () => {
    const lead = await createTestLead('PILOT-SCENARIO-1', 'Arun Prakash', '+919842010001');

    await runAsUser(OWNER_USER_ID, async (tx) => {
      const sim = simulateOutboundCallWithNila(lead, 'HOT_CALLBACK', 'Nila');
      const input = buildRecordOutcomeInputFromSimulation(lead, sim);

      const res = await tx.query<{
        result: {
          applied_temperature: string;
          call_outcome: string;
          follow_up_task_id: string;
          slot_verified: boolean;
        };
      }>(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          $7::timestamptz, $8::boolean, null, $9::jsonb, $10::integer
        ) AS result`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          input.callbackAt,
          false,
          JSON.stringify(input.structuredExtraction ?? {}),
          input.durationSeconds ?? 118,
        ]
      );

      expect(res.rows[0].result.applied_temperature).toBe('HOT');
      expect(res.rows[0].result.call_outcome).toBe('CALLBACK_REQUESTED');
      expect(res.rows[0].result.follow_up_task_id).toBeTruthy();
      // Since callback_schedule is blank by default, slot_verified is false (queued for founder review)
      expect(res.rows[0].result.slot_verified).toBe(false);
    });
  });

  it('Scenario 2: Interested lead with no confirmed next step becomes WARM', async () => {
    const lead = await createTestLead('PILOT-SCENARIO-2', 'Deepa Senthil', '+919842010002');

    await runAsUser(OWNER_USER_ID, async (tx) => {
      const sim = simulateOutboundCallWithNila(lead, 'WARM_INTEREST', 'Nila');
      const input = buildRecordOutcomeInputFromSimulation(lead, sim);

      const res = await tx.query<{
        result: {
          applied_temperature: string;
          call_outcome: string;
          follow_up_task_id: string | null;
        };
      }>(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          $7::timestamptz, $8::boolean, null, $9::jsonb, $10::integer
        ) AS result`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          input.callbackAt,
          false,
          JSON.stringify(input.structuredExtraction ?? {}),
          input.durationSeconds ?? 82,
        ]
      );

      expect(res.rows[0].result.applied_temperature).toBe('WARM');
      expect(res.rows[0].result.call_outcome).toBe('CONNECTED');
      expect(res.rows[0].result.follow_up_task_id).toBeNull();
    });
  });

  it('Scenario 3: An unanswered call remains UNQUALIFIED (and does not mark lead Cold)', async () => {
    const lead = await createTestLead('PILOT-SCENARIO-3', 'Vignesh Kumar', '+919842010003');

    await runAsUser(OWNER_USER_ID, async (tx) => {
      const sim = simulateOutboundCallWithNila(lead, 'NO_ANSWER', 'Nila');
      const input = buildRecordOutcomeInputFromSimulation(lead, sim);

      const res = await tx.query<{
        result: {
          applied_temperature: string;
          call_outcome: string;
        };
      }>(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          null, false, null, $7::jsonb, 0
        ) AS result`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          JSON.stringify(input.structuredExtraction ?? {}),
        ]
      );

      expect(res.rows[0].result.applied_temperature).toBe('UNQUALIFIED');
      expect(res.rows[0].result.call_outcome).toBe('NO_ANSWER');

      const leadRow = await tx.query<{ lead_temperature: string; latest_call_outcome: string }>(
        `SELECT lead_temperature, latest_call_outcome FROM public.leads WHERE id = $1`,
        [lead.id]
      );
      expect(leadRow.rows[0].lead_temperature).toBe('UNQUALIFIED');
      expect(leadRow.rows[0].latest_call_outcome).toBe('NO_ANSWER');
    });
  });

  it('Scenario 4: An opt-out blocks the next attempted call', async () => {
    const lead = await createTestLead('PILOT-SCENARIO-4', 'Meena Natarajan', '+919842010004');

    await runAsUser(OWNER_USER_ID, async (tx) => {
      // 1st call: lead opts out
      const sim = simulateOutboundCallWithNila(lead, 'OPT_OUT_DNC', 'Nila');
      const input = buildRecordOutcomeInputFromSimulation(lead, sim);

      await tx.query(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          null, true, null, $7::jsonb, 34
        )`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          JSON.stringify(input.structuredExtraction ?? {}),
        ]
      );

      const updatedLead = await tx.query<{ do_not_call: boolean }>(
        `SELECT do_not_call FROM public.leads WHERE id = $1`,
        [lead.id]
      );
      expect(updatedLead.rows[0].do_not_call).toBe(true);

      // 2nd attempted call in simulator is blocked
      expect(() =>
        simulateOutboundCallWithNila({ ...lead, do_not_call: true }, 'HOT_CALLBACK', 'Nila')
      ).toThrow(/Call blocked/i);

      // 2nd attempted call in Postgres RPC is also blocked
      await expect(
        tx.query(
          `SELECT public.record_call_outcome_and_follow_up(
            $1::uuid, $2::uuid, 'CONNECTED', 'HOT', 'Retry after DNC', 'Should fail',
            now(), false, null, '{}'::jsonb, 60
          )`,
          [workspaceId, lead.id]
        )
      ).rejects.toThrow(/Call blocked.*DO_NOT_CALL suppression active/i);
    });
  });

  it('Scenario 5: A pricing question with no approved rate gets a founder follow-up without an invented quote', async () => {
    const lead = await createTestLead('PILOT-SCENARIO-5', 'Surya Rajendran', '+919842010005');

    const pricingEval = buildApprovedPricingReply(DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS);
    expect(pricingEval.hasApprovedQuoteRange).toBe(false);
    expect(pricingEval.requiresFounderFollowUp).toBe(true);
    expect(pricingEval.replyText).toContain(
      'உங்க goal, campaign scope, ad budget தெரிஞ்சா team சரியான quote சொல்ல முடியும்.'
    );
    // Must not contain any invented rupee or numeric fee figure
    expect(pricingEval.replyText).not.toMatch(/₹|\bINR\b|\bRs\b|\d+/i);

    await runAsUser(OWNER_USER_ID, async (tx) => {
      const sim = simulateOutboundCallWithNila(
        lead,
        'PRICING_NO_APPROVED_RATE',
        'Nila',
        undefined,
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS
      );
      expect(sim.structuredExtraction.pricing_question_without_approved_rate).toBe(true);
      expect(sim.structuredExtraction.invented_quote).toBeNull();

      const input = buildRecordOutcomeInputFromSimulation(lead, sim);
      const res = await tx.query<{
        result: {
          applied_temperature: string;
          call_outcome: string;
          follow_up_task_id: string;
        };
      }>(
        `SELECT public.record_call_outcome_and_follow_up(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          $7::timestamptz, false, null, $8::jsonb, $9::integer
        ) AS result`,
        [
          input.workspaceId,
          input.leadId,
          input.callOutcome,
          input.proposedTemperature,
          input.qualificationReason,
          input.summary,
          input.callbackAt,
          JSON.stringify(input.structuredExtraction ?? {}),
          input.durationSeconds ?? 90,
        ]
      );

      expect(res.rows[0].result.follow_up_task_id).toBeTruthy();

      const taskRes = await tx.query<{
        id: string;
        task_type: string;
        title: string;
        status: string;
      }>(`SELECT id, task_type, title, status FROM public.follow_up_tasks WHERE id = $1`, [
        res.rows[0].result.follow_up_task_id,
      ]);

      expect(taskRes.rows).toHaveLength(1);
      expect(taskRes.rows[0].task_type).toBe('QUOTE_FOLLOW_UP');
      expect(taskRes.rows[0].title).toContain('no approved rate configured');
      expect(taskRes.rows[0].status).toBe('OPEN');
    });
  });
});

