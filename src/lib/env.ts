import { z } from 'zod';

export const DEFAULT_GOOGLE_SHEET_ID = '1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A';
export const DEFAULT_GOOGLE_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A/edit?usp=sharing';
export const DEFAULT_VOICE_AGENT_NAME = 'Nila';
export const DEFAULT_WORKSPACE_SLUG = 'digianchorz';
export const DEFAULT_WORKSPACE_NAME = 'DigiAnchorZ';
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_VOBIZ_API_BASE_URL = 'https://api.vobiz.ai';

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
});

export interface RuntimeEnvConfig {
  appMode: 'mock' | 'pilot';
  telephonyProviderMode: 'mock' | 'live';
  appBaseUrl: string;
  voicePublicBaseUrl: string;
  n8nBaseUrl: string;
  appTimezone: string;
  defaultWorkspaceSlug: string;
  defaultWorkspaceName: string;
  voiceAgentName: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string | undefined;
  databaseUrl: string | undefined;
  founderLoginEmail: string;
  authRedirectUrl: string;
  googleSheetId: string;
  googleSheetUrl: string;
  googleSheetTab: string;
  vobizApiBaseUrl: string;
  vobizPhoneNumber: string;
  vobizHostVerified: boolean;
  sarvamSttModel: string;
  sarvamSttMode: string;
  sarvamTtsModel: string;
  sarvamTtsSpeaker: string;
  sarvamTtsLanguage: string;
  llmProvider: string;
  llmModel: string;
  llmBaseUrl: string;
  isSupabaseConfigured: boolean;
  isVobizCredentialsConfigured: boolean;
  isExotelCredentialsConfigured: boolean;
  isTwilioCredentialsConfigured: boolean;
  isSarvamConfigured: boolean;
  isN8nConfigured: boolean;
  isGoogleSheetsApiConfigured: boolean;
}

export function isVerifiedVobizHostname(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'https:' &&
      (host === 'api.vobiz.ai' || host.endsWith('.vobiz.ai') || host === 'vobiz.ai')
    );
  } catch {
    return false;
  }
}

export function getPublicSupabaseConfig(): {
  url: string;
  publishableKey: string;
  isConfigured: boolean;
} {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const rawKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    '';

  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: rawUrl || undefined,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: rawKey || undefined,
  });

  const isPlaceholder =
    !rawUrl ||
    !rawKey ||
    rawUrl.includes('your-project-ref.supabase.co') ||
    rawKey.includes('your_public_key_here') ||
    rawKey.includes('your_supabase_anon_key_here');

  return {
    url: parsed.success && rawUrl ? rawUrl : 'https://your-project-ref.supabase.co',
    publishableKey: parsed.success && rawKey ? rawKey : 'sb_publishable_your_public_key_here',
    isConfigured: Boolean(parsed.success && rawUrl && rawKey && !isPlaceholder),
  };
}

/**
 * Server-only helper returning SARVAM_API_KEY. Never import or expose in client components.
 */
export function getServerSarvamApiKey(): string {
  const key = process.env.SARVAM_API_KEY?.trim() || '';
  if (!key || key === 'your_sarvam_api_key') {
    throw new Error('SARVAM_API_KEY is not configured on the server.');
  }
  return key;
}

/**
 * Server-only helper returning Vobiz credentials and verified API base URL.
 * Never import or expose in client components.
 */
export function getServerVobizConfig(): {
  authId: string;
  authToken: string;
  phoneNumber: string;
  apiBaseUrl: string;
  appId: string;
  isConfigured: boolean;
  hostVerified: boolean;
} {
  const authId = process.env.VOBIZ_AUTH_ID?.trim() || '';
  const authToken = process.env.VOBIZ_AUTH_TOKEN?.trim() || '';
  const phoneNumber = process.env.VOBIZ_PHONE_NUMBER?.trim() || '';
  const apiBaseUrl = (
    process.env.VOBIZ_API_BASE_URL?.trim() || DEFAULT_VOBIZ_API_BASE_URL
  ).replace(/\/+$/, '');
  const appId = process.env.VOBIZ_APP_ID?.trim() || '';
  const hostVerified = isVerifiedVobizHostname(apiBaseUrl);

  const isConfigured = Boolean(
    authId &&
      authToken &&
      phoneNumber &&
      !authId.includes('your_vobiz') &&
      !authToken.includes('your_vobiz') &&
      hostVerified
  );

  return {
    authId,
    authToken,
    phoneNumber,
    apiBaseUrl,
    appId,
    isConfigured,
    hostVerified,
  };
}

export function getRuntimeEnv(): RuntimeEnvConfig {
  const supa = getPublicSupabaseConfig();
  const appBaseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:3000';
  const vobiz = getServerVobizConfig();

  const exotelKey = process.env.EXOTEL_API_KEY?.trim() || '';
  const exotelToken = process.env.EXOTEL_API_TOKEN?.trim() || '';
  const isExotelCredentialsConfigured = Boolean(
    exotelKey &&
      exotelToken &&
      !exotelKey.includes('your_exotel_api_key') &&
      !exotelToken.includes('your_exotel_api_token')
  );

  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || '';
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim() || '';
  const twilioApiKeySid = process.env.TWILIO_API_KEY_SID?.trim() || '';
  const twilioApiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim() || '';
  const isTwilioCredentialsConfigured = Boolean(
    twilioAccountSid &&
      (twilioAuthToken || (twilioApiKeySid && twilioApiKeySecret)) &&
      !twilioAccountSid.includes('your_twilio_account_sid')
  );

  const sarvamKey = process.env.SARVAM_API_KEY?.trim() || '';
  const isSarvamConfigured = Boolean(sarvamKey && sarvamKey !== 'your_sarvam_api_key');

  const n8nBaseUrl = (process.env.N8N_BASE_URL?.trim() || '').replace(/\/+$/, '');
  const isN8nConfigured = Boolean(n8nBaseUrl && !n8nBaseUrl.includes('placeholder'));

  const gsaEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || '';
  const gsaKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() || '';
  const isGoogleSheetsApiConfigured = Boolean(
    gsaEmail &&
      gsaKey &&
      !gsaEmail.includes('your-service-account') &&
      !gsaKey.includes('YOUR_PRIVATE_KEY')
  );

  return {
    appMode: process.env.APP_MODE === 'pilot' ? 'pilot' : 'mock',
    telephonyProviderMode: process.env.TELEPHONY_PROVIDER_MODE === 'live' ? 'live' : 'mock',
    appBaseUrl,
    voicePublicBaseUrl: (process.env.VOICE_PUBLIC_BASE_URL?.trim() || appBaseUrl).replace(/\/+$/, ''),
    n8nBaseUrl,
    appTimezone: process.env.APP_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    defaultWorkspaceSlug: process.env.DEFAULT_WORKSPACE_SLUG?.trim() || DEFAULT_WORKSPACE_SLUG,
    defaultWorkspaceName: process.env.DEFAULT_WORKSPACE_NAME?.trim() || DEFAULT_WORKSPACE_NAME,
    voiceAgentName: process.env.VOICE_AGENT_NAME?.trim() || DEFAULT_VOICE_AGENT_NAME,
    supabaseUrl: supa.url,
    supabasePublishableKey: supa.publishableKey,
    supabaseSecretKey:
      process.env.SUPABASE_SECRET_KEY?.trim() ||
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
      undefined,
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    founderLoginEmail: process.env.FOUNDER_LOGIN_EMAIL?.trim() || 'founder@digianchorz.com',
    authRedirectUrl:
      process.env.SUPABASE_AUTH_REDIRECT_URL?.trim() || `${appBaseUrl}/auth/callback`,
    googleSheetId: process.env.GOOGLE_SHEET_ID?.trim() || DEFAULT_GOOGLE_SHEET_ID,
    googleSheetUrl: process.env.GOOGLE_SHEET_URL?.trim() || DEFAULT_GOOGLE_SHEET_URL,
    googleSheetTab: process.env.GOOGLE_SHEET_TAB?.trim() || 'Leads',
    vobizApiBaseUrl: vobiz.apiBaseUrl,
    vobizPhoneNumber: vobiz.phoneNumber,
    vobizHostVerified: vobiz.hostVerified,
    sarvamSttModel: process.env.SARVAM_STT_MODEL?.trim() || 'saaras:v4',
    sarvamSttMode: process.env.SARVAM_STT_MODE?.trim() || 'codemix',
    sarvamTtsModel: process.env.SARVAM_TTS_MODEL?.trim() || 'bulbul:v3',
    sarvamTtsSpeaker: process.env.SARVAM_TTS_SPEAKER?.trim() || 'ritu',
    sarvamTtsLanguage: process.env.SARVAM_TTS_LANGUAGE?.trim() || 'ta-IN',
    llmProvider: process.env.LLM_PROVIDER?.trim() || 'sarvam',
    llmModel: process.env.LLM_MODEL?.trim() || 'sarvam-105b-conversations',
    llmBaseUrl: process.env.LLM_BASE_URL?.trim() || 'https://api.sarvam.ai/v1',
    isSupabaseConfigured: supa.isConfigured,
    isVobizCredentialsConfigured: vobiz.isConfigured,
    isExotelCredentialsConfigured,
    isTwilioCredentialsConfigured,
    isSarvamConfigured,
    isN8nConfigured,
    isGoogleSheetsApiConfigured,
  };
}
