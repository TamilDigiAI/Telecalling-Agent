import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_GOOGLE_SHEET_ID, DEFAULT_WORKSPACE_SLUG } from '@/lib/env';
import { getServerAutomationSupabaseClient, verifyN8nBackendAuth } from '@/lib/n8n/auth';
import { PILOT_FOUNDER_USER_ID } from '@/lib/supabase/local-pilot-fallback';
import type { CallQueueJob, CallingEligibility, Lead, LeadSuppression, Workspace } from '@/types/crm';

export const runtime = 'nodejs';

export function normalizePhoneToE164(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0') && /^0[6-9]\d{9}$/.test(digits)) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) {
    return `+${digits}`;
  }
  if (trimmed.startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

function parseBooleanFlag(val: unknown): boolean {
  const normalized = String(val ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'y';
}

function parseEligibility(val: unknown): CallingEligibility {
  const normalized = String(val ?? '').trim().toUpperCase();
  if (normalized === 'INELIGIBLE' || normalized === 'NO' || normalized === 'FALSE') {
    return 'INELIGIBLE';
  }
  if (normalized === 'PENDING_REVIEW' || normalized === 'REVIEW') {
    return 'PENDING_REVIEW';
  }
  return 'ELIGIBLE';
}

interface IncomingSheetRow {
  rowNumber?: number;
  row_number?: number;
  leadId?: string;
  'Lead ID'?: string;
  externalLeadId?: string;
  name?: string;
  Name?: string;
  phone?: string;
  Phone?: string;
  service?: string;
  Service?: string;
  source?: string;
  Source?: string;
  createdAt?: string;
  'Created At'?: string;
  callingEligibility?: string;
  'Calling Eligibility'?: string;
  eligibilityReference?: string;
  'Eligibility Reference'?: string;
  doNotCall?: string | boolean;
  'Do Not Call'?: string | boolean;
}

/**
 * POST /api/n8n/lead-import
 * Invoked by n8n Workflow A ("Nila — Lead Intake").
 * Validates eligibility, suppression, phone number, and stable Lead ID.
 * Upserts CRM lead while preserving existing call history, and creates at most ONE
 * eligible pending call job in `call_queue_jobs`.
 */
export async function POST(request: NextRequest) {
  try {
    if (!verifyN8nBackendAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized n8n request' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as
      | IncomingSheetRow
      | { rows?: IncomingSheetRow[]; workspaceSlug?: string; autoEnqueueCalls?: boolean };

    const rows: IncomingSheetRow[] = Array.isArray((body as { rows?: IncomingSheetRow[] }).rows)
      ? (body as { rows: IncomingSheetRow[] }).rows
      : [body as IncomingSheetRow];

    const workspaceSlug =
      (body as { workspaceSlug?: string }).workspaceSlug?.trim() || DEFAULT_WORKSPACE_SLUG;
    const autoEnqueueCalls = (body as { autoEnqueueCalls?: boolean }).autoEnqueueCalls !== false;

    const supabase = await getServerAutomationSupabaseClient();

    const { data: wsData } = await supabase
      .from('workspaces')
      .select('*')
      .eq('slug', workspaceSlug)
      .maybeSingle();

    const workspace = wsData as Workspace | null;
    if (!workspace) {
      return NextResponse.json({ error: `Workspace "${workspaceSlug}" not found` }, { status: 404 });
    }

    const [{ data: existingLeadsData }, { data: suppressionsData }, { data: existingQueueData }] =
      await Promise.all([
        supabase.from('leads').select('*').eq('workspace_id', workspace.id),
        supabase
          .from('lead_suppressions')
          .select('*')
          .eq('workspace_id', workspace.id)
          .eq('active', true),
        supabase.from('call_queue_jobs').select('*').eq('workspace_id', workspace.id),
      ]);

    const existingLeads = (existingLeadsData ?? []) as Lead[];
    const suppressedPhones = new Set(
      ((suppressionsData ?? []) as LeadSuppression[]).map((s) => s.phone_e164)
    );
    const activeQueueLeadIds = new Set(
      ((existingQueueData ?? []) as CallQueueJob[])
        .filter((j) => ['PENDING', 'CLAIMED', 'DIALING', 'RECONCILING'].includes(j.status))
        .map((j) => j.lead_id)
    );

    // Detect duplicate Lead IDs within the incoming batch
    const batchLeadIdCounts = new Map<string, number>();
    for (const r of rows) {
      const lid = String(r['Lead ID'] ?? r.leadId ?? r.externalLeadId ?? '').trim();
      if (lid) {
        batchLeadIdCounts.set(lid, (batchLeadIdCounts.get(lid) || 0) + 1);
      }
    }

    const results: Array<{
      externalLeadId: string;
      crmLeadId: string | null;
      action: 'created' | 'updated' | 'flagged_for_review' | 'skipped_invalid_phone';
      callJobCreated: boolean;
      callJobId: string | null;
      reason?: string;
    }> = [];

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const sheetRowNumber = Number(row.row_number ?? row.rowNumber ?? idx + 2);
      const rawLeadId = String(row['Lead ID'] ?? row.leadId ?? row.externalLeadId ?? '').trim();
      const rawPhone = String(row.Phone ?? row.phone ?? '').trim();
      const phoneE164 = normalizePhoneToE164(rawPhone);
      const fullName = String(row.Name ?? row.name ?? '').trim() || `Sheet Lead Row ${sheetRowNumber}`;
      const serviceInterest =
        String(row.Service ?? row.service ?? '').trim() ||
        'Meta Ads for Facebook and Instagram lead generation';
      const source = String(row.Source ?? row.source ?? '').trim() || 'Google Sheet';
      const eligibilityRef =
        String(row['Eligibility Reference'] ?? row.eligibilityReference ?? '').trim() ||
        `GSHEET-ROW-${sheetRowNumber}`;
      const sheetDnc = parseBooleanFlag(row['Do Not Call'] ?? row.doNotCall);

      if (!phoneE164) {
        results.push({
          externalLeadId: rawLeadId || `MISSING-ID-ROW-${sheetRowNumber}`,
          crmLeadId: null,
          action: 'skipped_invalid_phone',
          callJobCreated: false,
          callJobId: null,
          reason: `Invalid or missing phone number "${rawPhone}"`,
        });
        continue;
      }

      const isMissingLeadId = !rawLeadId;
      const isDuplicateInBatch = Boolean(rawLeadId && (batchLeadIdCounts.get(rawLeadId) || 0) > 1);
      const externalLeadId = rawLeadId || `REVIEW-MISSING-ID-ROW-${sheetRowNumber}`;
      const flaggedForReview = isMissingLeadId || isDuplicateInBatch;
      const reviewReason = isMissingLeadId
        ? `Missing Lead ID at Sheet row ${sheetRowNumber}`
        : isDuplicateInBatch
          ? `Duplicate Lead ID "${rawLeadId}" detected in Google Sheet`
          : null;

      const callingEligibility: CallingEligibility = flaggedForReview
        ? 'PENDING_REVIEW'
        : parseEligibility(row['Calling Eligibility'] ?? row.callingEligibility);

      const isSuppressed = sheetDnc || suppressedPhones.has(phoneE164);

      // Match by stable source Lead ID first, then fallback to phone_e164
      const existing =
        existingLeads.find((l) => l.external_lead_id === externalLeadId) ??
        (!isMissingLeadId ? existingLeads.find((l) => l.phone_e164 === phoneE164) : undefined);

      let lead: Lead;
      let action: 'created' | 'updated' | 'flagged_for_review' = flaggedForReview
        ? 'flagged_for_review'
        : existing
          ? 'updated'
          : 'created';

      if (!existing) {
        const { data: inserted, error: insertErr } = await supabase
          .from('leads')
          .insert({
            workspace_id: workspace.id,
            external_lead_id: externalLeadId,
            sheet_id: workspace.google_sheet_id || DEFAULT_GOOGLE_SHEET_ID,
            sheet_tab: workspace.google_sheet_tab || 'Leads',
            sheet_row_number: Number.isFinite(sheetRowNumber) ? sheetRowNumber : 2,
            row_bound_key: `${externalLeadId}::${phoneE164}`,
            full_name: fullName,
            raw_phone: rawPhone,
            phone_e164: phoneE164,
            service_interest: serviceInterest,
            source,
            calling_eligibility: callingEligibility,
            eligibility_reference: eligibilityRef,
            available_window: '09:00-20:00 IST',
            do_not_call: isSuppressed,
            lead_temperature: 'UNQUALIFIED',
            attempts_count: 0,
            owner_user_id: PILOT_FOUNDER_USER_ID,
            sync_status: 'PENDING',
            flagged_for_review: flaggedForReview,
            review_reason: reviewReason,
          })
          .select('*')
          .single();

        if (insertErr || !inserted) {
          throw insertErr || new Error(`Failed to insert lead ${externalLeadId}`);
        }
        lead = inserted as Lead;
        existingLeads.push(lead);
      } else {
        // Preserve ALL existing call history (lead_temperature, latest_call_outcome, attempts_count, call_summary, callback_at, last_call_at)
        const { data: updated } = await supabase
          .from('leads')
          .update({
            full_name: fullName || existing.full_name,
            raw_phone: rawPhone || existing.raw_phone,
            service_interest: serviceInterest || existing.service_interest,
            source: source || existing.source,
            sheet_row_number: Number.isFinite(sheetRowNumber)
              ? sheetRowNumber
              : existing.sheet_row_number,
            row_bound_key: `${existing.external_lead_id}::${existing.phone_e164}`,
            calling_eligibility: flaggedForReview ? 'PENDING_REVIEW' : callingEligibility,
            eligibility_reference: eligibilityRef || existing.eligibility_reference,
            do_not_call: existing.do_not_call || isSuppressed,
            flagged_for_review: flaggedForReview || Boolean(existing.flagged_for_review),
            review_reason: reviewReason ?? existing.review_reason ?? null,
          })
          .eq('workspace_id', workspace.id)
          .eq('id', existing.id)
          .select('*')
          .maybeSingle();

        lead = (updated as Lead | null) ?? existing;
        action = flaggedForReview ? 'flagged_for_review' : 'updated';
      }

      // Record suppression immediately if sheet Do Not Call = TRUE
      if (sheetDnc && !suppressedPhones.has(phoneE164)) {
        await supabase.from('lead_suppressions').upsert(
          {
            workspace_id: workspace.id,
            lead_id: lead.id,
            phone_e164: phoneE164,
            reason: 'DO_NOT_CALL',
            notes: 'Imported with Do Not Call = TRUE from Google Sheet',
            active: true,
          },
          { onConflict: 'workspace_id,phone_e164' }
        );
        suppressedPhones.add(phoneE164);

        // Cancel any queued calls for this lead
        await supabase
          .from('call_queue_jobs')
          .update({ status: 'CANCELLED', last_error: 'Suppressed via Google Sheet Do Not Call' })
          .eq('workspace_id', workspace.id)
          .eq('lead_id', lead.id)
          .in('status', ['PENDING', 'CLAIMED', 'DIALING', 'RECONCILING']);
        activeQueueLeadIds.delete(lead.id);
      }

      // Create at most ONE eligible pending call job only when autoEnqueueCalls is enabled
      const canEnqueue =
        autoEnqueueCalls &&
        !flaggedForReview &&
        callingEligibility === 'ELIGIBLE' &&
        !isSuppressed &&
        !lead.do_not_call &&
        (lead.attempts_count || 0) < (workspace.attempt_cap || 3) &&
        !activeQueueLeadIds.has(lead.id);

      let callJobCreated = false;
      let callJobId: string | null = null;

      if (canEnqueue) {
        const idempotencyKey = `intake-call:${lead.id}:attempt-${(lead.attempts_count || 0) + 1}`;
        const existingSameKey = ((existingQueueData ?? []) as CallQueueJob[]).find(
          (j) => j.idempotency_key === idempotencyKey
        );

        if (!existingSameKey) {
          const { data: qJob } = await supabase
            .from('call_queue_jobs')
            .upsert(
              {
                workspace_id: workspace.id,
                lead_id: lead.id,
                status: 'PENDING',
                idempotency_key: idempotencyKey,
                scheduled_for: new Date().toISOString(),
                attempts: 0,
                max_attempts: workspace.attempt_cap || 3,
                locked_by: null,
                lease_expires_at: null,
                call_attempt_id: null,
                last_error: null,
              },
              { onConflict: 'workspace_id,idempotency_key' }
            )
            .select('*')
            .maybeSingle();

          if (qJob) {
            callJobCreated = true;
            callJobId = (qJob as CallQueueJob).id;
            activeQueueLeadIds.add(lead.id);
          }
        }
      }

      results.push({
        externalLeadId: lead.external_lead_id,
        crmLeadId: lead.id,
        action,
        callJobCreated,
        callJobId,
        reason: reviewReason ?? (isSuppressed ? 'Suppressed (Do Not Call)' : undefined),
      });
    }

    return NextResponse.json({
      ok: true,
      workspaceId: workspace.id,
      processedCount: results.length,
      callJobsCreated: results.filter((r) => r.callJobCreated).length,
      flaggedForReviewCount: results.filter((r) => r.action === 'flagged_for_review').length,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lead import failed' },
      { status: 500 }
    );
  }
}
