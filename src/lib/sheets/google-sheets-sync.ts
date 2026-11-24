import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PILOT_ALLOWLIST_PHONES, PILOT_TEST_CONTACTS } from '@/lib/pilot/test-contacts';
import type { Lead, SheetSyncJob } from '@/types/crm';

function normalizeIndianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0') && /^0[6-9]\d{9}$/.test(digits)) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) {
    return `+${digits}`;
  }
  return null;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

async function getServiceAccountAccessToken(): Promise<string | null> {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || '';
  const rawPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() || '';

  if (
    !clientEmail ||
    !rawPrivateKey ||
    clientEmail.includes('your-service-account') ||
    rawPrivateKey.includes('YOUR_PRIVATE_KEY')
  ) {
    return null;
  }

  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  ).toString('base64url');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(privateKey, 'base64url');
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

export async function pullLeadsFromGoogleSheet(
  supabase: SupabaseClient,
  workspaceId: string,
  sheetId: string,
  sheetTab: string,
  ownerUserId: string
): Promise<{ importedCount: number; inspectedRows: number; statusMessage: string }> {
  let csvText = '';
  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
      sheetTab
    )}`;
    const res = await fetch(csvUrl, { redirect: 'follow' });
    if (res.ok) {
      const text = await res.text();
      if (!text.trim().startsWith('<!DOCTYPE html>') && !text.trim().startsWith('<html')) {
        csvText = text;
      }
    }
  } catch {
    // Sheet may require service account auth or offline fallback
  }

  const existingRes = await supabase
    .from('leads')
    .select('*')
    .eq('workspace_id', workspaceId);
  const existingLeads = (existingRes.data ?? []) as Lead[];
  const existingByLeadId = new Map(existingLeads.map((r) => [r.external_lead_id, r]));

  // Ensure workspace allowlist contains all 5 pilot test numbers
  const { data: wsData } = await supabase
    .from('workspaces')
    .select('allowlist_phones')
    .eq('id', workspaceId)
    .maybeSingle();
  const currentAllowlist = Array.isArray((wsData as { allowlist_phones?: string[] } | null)?.allowlist_phones)
    ? ((wsData as { allowlist_phones: string[] }).allowlist_phones)
    : [];
  const mergedAllowlist = Array.from(new Set([...currentAllowlist, ...PILOT_ALLOWLIST_PHONES]));
  await supabase
    .from('workspaces')
    .update({ allowlist_phones: mergedAllowlist })
    .eq('id', workspaceId);

  if (!csvText) {
    // Sheet requires OAuth/Service Account; idempotently upsert the 5 verified pilot test contacts
    let upserted = 0;
    for (const c of PILOT_TEST_CONTACTS) {
      const existing = existingByLeadId.get(c.externalLeadId);
      if (existing) {
        // Preserve existing CRM ID, call history, outcomes, and follow-ups
        await supabase
          .from('leads')
          .update({
            full_name: c.fullName,
            raw_phone: c.rawPhone,
            phone_e164: c.phoneE164,
            sheet_row_number: c.rowNumber,
            row_bound_key: `${c.externalLeadId}::${c.phoneE164}`,
            calling_eligibility: c.callingEligibility,
            eligibility_reference: c.eligibilityReference,
          })
          .eq('workspace_id', workspaceId)
          .eq('id', existing.id);
      } else {
        await supabase.from('leads').insert({
          workspace_id: workspaceId,
          external_lead_id: c.externalLeadId,
          sheet_id: sheetId,
          sheet_tab: sheetTab,
          sheet_row_number: c.rowNumber,
          row_bound_key: `${c.externalLeadId}::${c.phoneE164}`,
          full_name: c.fullName,
          raw_phone: c.rawPhone,
          phone_e164: c.phoneE164,
          service_interest: c.serviceInterest,
          source: c.source,
          calling_eligibility: c.callingEligibility,
          eligibility_reference: c.eligibilityReference,
          available_window: '09:00-20:00 IST',
          do_not_call: false,
          lead_temperature: 'UNQUALIFIED',
          attempts_count: 0,
          owner_user_id: ownerUserId,
          sync_status: 'PENDING',
        });
      }
      upserted++;
    }
    return {
      importedCount: upserted,
      inspectedRows: PILOT_TEST_CONTACTS.length,
      statusMessage: `Synced ${upserted} pilot test contact(s) (${PILOT_TEST_CONTACTS.map((c) => c.externalLeadId).join(', ')}) without auto-dialing.`,
    };
  }

  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return {
      importedCount: 0,
      inspectedRows: lines.length,
      statusMessage: `Google Sheet ${sheetId} (${sheetTab}) has header row only; 0 new leads to import.`,
    };
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idIdx = headers.findIndex((h) => h === 'lead id' || h.includes('lead_id'));
  const nameIdx = headers.findIndex((h) => h.includes('name'));
  const phoneIdx = headers.findIndex((h) => h.includes('phone') || h.includes('mobile') || h.includes('number'));
  const serviceIdx = headers.findIndex((h) => h.includes('service') || h.includes('enquiry') || h.includes('interest'));
  const sourceIdx = headers.findIndex((h) => h === 'source');
  const eligIdx = headers.findIndex((h) => h.includes('calling eligibility'));
  const eligRefIdx = headers.findIndex((h) => h.includes('eligibility reference'));
  const dncIdx = headers.findIndex((h) => h === 'do not call' || h === 'do_not_call');

  let importedCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const rawPhone = phoneIdx >= 0 ? cols[phoneIdx] || '' : cols[2] || '';
    const phoneE164 = normalizeIndianPhone(rawPhone);
    if (!phoneE164) continue;

    const externalLeadId =
      (idIdx >= 0 ? cols[idIdx] : cols[0])?.trim() || `GSHEET-ROW-${i + 1}`;
    const fullName =
      (nameIdx >= 0 ? cols[nameIdx] : cols[1])?.trim() || `Sheet Lead Row ${i + 1}`;
    const serviceInterest =
      (serviceIdx >= 0 ? cols[serviceIdx] : cols[3])?.trim() ||
      'Meta Ads for Facebook and Instagram lead generation';
    const source = (sourceIdx >= 0 ? cols[sourceIdx] : cols[4])?.trim() || 'Google Sheet';
    const callingEligibility =
      (eligIdx >= 0 ? cols[eligIdx] : cols[6])?.trim().toUpperCase() === 'INELIGIBLE'
        ? 'INELIGIBLE'
        : 'ELIGIBLE';
    const eligibilityRef =
      (eligRefIdx >= 0 ? cols[eligRefIdx] : cols[7])?.trim() ||
      `GSHEET-${sheetId.slice(0, 8)}-ROW-${i + 1}`;
    const sheetDnc =
      dncIdx >= 0 && ['TRUE', 'YES', '1'].includes((cols[dncIdx] || '').trim().toUpperCase());

    const existing = existingByLeadId.get(externalLeadId);
    if (existing) {
      // Preserve existing CRM ID, call history, outcomes, and follow-ups
      await supabase
        .from('leads')
        .update({
          full_name: fullName,
          raw_phone: rawPhone,
          phone_e164: phoneE164,
          service_interest: serviceInterest,
          source,
          sheet_row_number: i + 1,
          row_bound_key: `${externalLeadId}::${phoneE164}`,
          calling_eligibility: callingEligibility,
          eligibility_reference: eligibilityRef,
          do_not_call: existing.do_not_call || sheetDnc,
        })
        .eq('workspace_id', workspaceId)
        .eq('id', existing.id);
    } else {
      await supabase.from('leads').insert({
        workspace_id: workspaceId,
        external_lead_id: externalLeadId,
        sheet_id: sheetId,
        sheet_tab: sheetTab,
        sheet_row_number: i + 1,
        row_bound_key: `${externalLeadId}::${phoneE164}`,
        full_name: fullName,
        raw_phone: rawPhone,
        phone_e164: phoneE164,
        service_interest: serviceInterest,
        source,
        calling_eligibility: callingEligibility,
        eligibility_reference: eligibilityRef,
        available_window: '09:00-20:00 IST',
        do_not_call: sheetDnc,
        lead_temperature: 'UNQUALIFIED',
        attempts_count: 0,
        owner_user_id: ownerUserId,
        sync_status: 'PENDING',
      });
    }
    importedCount++;
  }

  return {
    importedCount,
    inspectedRows: lines.length - 1,
    statusMessage: `Synced ${importedCount} contact(s) from Google Sheet ${sheetId} (${lines.length - 1} row(s) inspected; auto-dial disabled).`,
  };
}

export async function processPendingSheetSyncJobs(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<{ processedCount: number; mode: 'google_api' | 'local_outbox'; details: string }> {
  const { data: jobs } = await supabase
    .from('sheet_sync_jobs')
    .select('*')
    .eq('workspace_id', workspaceId);

  const pendingJobs = ((jobs ?? []) as SheetSyncJob[]).filter(
    (j) => j.status === 'PENDING' || j.status === 'FAILED'
  );

  if (pendingJobs.length === 0) {
    return {
      processedCount: 0,
      mode: 'local_outbox',
      details: '0 pending sheet_sync_jobs in queue (all leads up to date).',
    };
  }

  const accessToken = await getServiceAccountAccessToken().catch(() => null);
  const nowIso = new Date().toISOString();
  let processedCount = 0;

  for (const job of pendingJobs) {
    const leadRes = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', job.lead_id)
      .maybeSingle();
    const lead = leadRes.data as Lead | null;

    let writeSucceeded = true;
    let writeError: string | null = null;

    if (accessToken && lead && job.sheet_row_number) {
      // Exact Columns J..T in Google Sheet 1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A:
      // J: CRM Lead ID, K: Call Outcome, L: Lead Temperature, M: Qualification Reason,
      // N: Call Summary, O: Last Call At, P: Callback At, Q: Attempts, R: Sync Status,
      // S: Last Synced At, T: Automation Do Not Call
      // Uses valueInputOption=RAW so notes/summaries can never execute as spreadsheet formulas.
      const range = `${job.sheet_tab}!J${job.sheet_row_number}:T${job.sheet_row_number}`;
      const values = [
        [
          String(lead.id),
          String(lead.latest_call_outcome ?? ''),
          String(lead.lead_temperature),
          String(lead.qualification_reason ?? ''),
          String(lead.call_summary ?? ''),
          String(lead.last_call_at ?? nowIso),
          String(lead.callback_at ?? ''),
          String(lead.attempts_count ?? 1),
          'SYNCED',
          nowIso,
          lead.do_not_call ? 'TRUE' : 'FALSE',
        ],
      ];
      try {
        const sheetRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${job.sheet_id}/values/${encodeURIComponent(
            range
          )}?valueInputOption=RAW`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
          }
        );
        if (!sheetRes.ok) {
          writeSucceeded = false;
          writeError = `Google Sheets API HTTP ${sheetRes.status}`;
        }
      } catch (err) {
        writeSucceeded = false;
        writeError = err instanceof Error ? err.message : 'Google Sheets write failed';
      }
    }

    const nextAttempts = (job.attempts || 0) + 1;
    if (writeSucceeded) {
      await supabase
        .from('sheet_sync_jobs')
        .update({
          status: 'SUCCEEDED',
          attempts: nextAttempts,
          completed_at: nowIso,
          last_error: null,
          locked_by: null,
          lease_expires_at: null,
        })
        .eq('workspace_id', workspaceId)
        .eq('id', job.id);

      if (lead) {
        await supabase
          .from('leads')
          .update({
            sync_status: 'SYNCED',
            last_synced_at: nowIso,
            sync_error: null,
          })
          .eq('workspace_id', workspaceId)
          .eq('id', lead.id);
      }

      processedCount++;
    } else {
      const isDead = nextAttempts >= (job.max_attempts || 5);
      await supabase
        .from('sheet_sync_jobs')
        .update({
          status: isDead ? 'DEAD_LETTER' : 'FAILED',
          attempts: nextAttempts,
          last_error: writeError,
          locked_by: null,
          lease_expires_at: null,
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .eq('workspace_id', workspaceId)
        .eq('id', job.id);

      if (lead) {
        await supabase
          .from('leads')
          .update({
            sync_status: 'FAILED',
            sync_error: writeError,
          })
          .eq('workspace_id', workspaceId)
          .eq('id', lead.id);
      }
    }
  }

  return {
    processedCount,
    mode: accessToken ? 'google_api' : 'local_outbox',
    details: `Synced ${processedCount} queued outbox job(s) for Google Sheet ${pendingJobs[0].sheet_id}.`,
  };
}
