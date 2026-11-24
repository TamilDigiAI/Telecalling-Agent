import { getRuntimeEnv } from '@/lib/env';
import { buildVobizWebhookUrls } from '@/lib/telephony/vobiz-client';

export type IntegrationStatusBadge =
  | 'Connected'
  | 'Configured (Unverified)'
  | 'Local Fallback (Mock)'
  | 'Not Configured'
  | 'Error';

export interface IntegrationHealthItem {
  id: 'vobiz' | 'sarvam' | 'supabase' | 'n8n' | 'google_sheets';
  name: string;
  status: IntegrationStatusBadge;
  detail: string;
  missingVars: string[];
}

/**
 * Evaluates integration health across Vobiz, Sarvam, Supabase, n8n, and Google Sheets.
 * Strictly follows the rule: "Connected" is ONLY emitted when verified provider/media
 * evidence exists; otherwise reports "Configured (Unverified)", "Local Fallback (Mock)",
 * or "Not Configured".
 */
export function getIntegrationHealthSummary(verifiedEvidence?: {
  vobizVerified?: boolean;
  sarvamVerified?: boolean;
  supabaseVerified?: boolean;
  n8nVerified?: boolean;
  googleSheetsVerified?: boolean;
}): {
  items: IntegrationHealthItem[];
  vobizUrls: ReturnType<typeof buildVobizWebhookUrls>;
} {
  const env = getRuntimeEnv();
  const vobizUrls = buildVobizWebhookUrls(env.voicePublicBaseUrl);

  const vobizMissing: string[] = [];
  if (!process.env.VOBIZ_AUTH_ID?.trim()) vobizMissing.push('VOBIZ_AUTH_ID');
  if (!process.env.VOBIZ_AUTH_TOKEN?.trim()) vobizMissing.push('VOBIZ_AUTH_TOKEN');
  if (!process.env.VOBIZ_PHONE_NUMBER?.trim()) vobizMissing.push('VOBIZ_PHONE_NUMBER');

  const vobizStatus: IntegrationStatusBadge = verifiedEvidence?.vobizVerified
    ? 'Connected'
    : env.isVobizCredentialsConfigured
      ? 'Configured (Unverified)'
      : 'Not Configured';

  const sarvamMissing: string[] = [];
  if (!env.isSarvamConfigured) sarvamMissing.push('SARVAM_API_KEY');
  const sarvamStatus: IntegrationStatusBadge = verifiedEvidence?.sarvamVerified
    ? 'Connected'
    : env.isSarvamConfigured
      ? 'Configured (Unverified)'
      : 'Not Configured';

  const supabaseMissing: string[] = [];
  if (!env.isSupabaseConfigured) {
    supabaseMissing.push('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  }
  if (!env.supabaseSecretKey) supabaseMissing.push('SUPABASE_SECRET_KEY');

  const supabaseStatus: IntegrationStatusBadge = verifiedEvidence?.supabaseVerified
    ? 'Connected'
    : env.isSupabaseConfigured && env.supabaseSecretKey
      ? 'Configured (Unverified)'
      : env.isSupabaseConfigured
        ? 'Local Fallback (Mock)'
        : 'Not Configured';

  const n8nMissing: string[] = [];
  if (!env.isN8nConfigured) n8nMissing.push('N8N_BASE_URL');
  const n8nStatus: IntegrationStatusBadge = verifiedEvidence?.n8nVerified
    ? 'Connected'
    : env.isN8nConfigured
      ? 'Configured (Unverified)'
      : 'Not Configured';

  const sheetsMissing: string[] = [];
  if (!env.isGoogleSheetsApiConfigured) {
    sheetsMissing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  }
  const sheetsStatus: IntegrationStatusBadge = verifiedEvidence?.googleSheetsVerified
    ? 'Connected'
    : env.isGoogleSheetsApiConfigured
      ? 'Configured (Unverified)'
      : 'Not Configured';

  return {
    vobizUrls,
    items: [
      {
        id: 'vobiz',
        name: 'Vobiz Telephony',
        status: vobizStatus,
        detail: env.isVobizCredentialsConfigured
          ? `Host verified (${env.vobizApiBaseUrl}) · Caller ID: ${env.vobizPhoneNumber}`
          : `API Host: ${env.vobizApiBaseUrl} · Awaiting VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_PHONE_NUMBER`,
        missingVars: vobizMissing,
      },
      {
        id: 'sarvam',
        name: 'Sarvam Speech & Dialogue (Nila · Ritu)',
        status: sarvamStatus,
        detail: `STT: ${env.sarvamSttModel} (${env.sarvamSttMode}) · LLM: ${env.llmModel} · TTS: ${env.sarvamTtsModel} (${env.sarvamTtsSpeaker}, ${env.sarvamTtsLanguage})`,
        missingVars: sarvamMissing,
      },
      {
        id: 'supabase',
        name: 'Supabase Auth & Postgres CRM',
        status: supabaseStatus,
        detail: env.supabaseSecretKey
          ? 'Supabase URL, Publishable Key & Secret Key configured (RLS enabled)'
          : 'Public Supabase configured; SUPABASE_SECRET_KEY missing (server workers use local pilot fallback)',
        missingVars: supabaseMissing,
      },
      {
        id: 'n8n',
        name: 'n8n Automation (3 Workflows)',
        status: n8nStatus,
        detail: env.isN8nConfigured
          ? `Instance: ${env.n8nBaseUrl} · Workflows generated in n8n/*.json`
          : 'Workflow JSONs generated (n8n/nila-*.json) — awaiting import into n8n instance',
        missingVars: n8nMissing,
      },
      {
        id: 'google_sheets',
        name: 'Google Sheets (Lead Intake & Write-back)',
        status: sheetsStatus,
        detail: `Sheet ID: ${env.googleSheetId} · Tab: ${env.googleSheetTab} · Write mode: RAW (J:T only)`,
        missingVars: sheetsMissing,
      },
    ],
  };
}
