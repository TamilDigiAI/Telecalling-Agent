import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getRuntimeEnv } from '@/lib/env';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/server';
import {
  createLocalPilotSupabaseClient,
  createPilotFounderCookieValue,
  verifyPilotFounderCookieValue,
} from '@/lib/supabase/local-pilot-fallback';

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies n8n backend API requests using N8N_WEBHOOK_SECRET via
 * `x-n8n-webhook-secret` or `Authorization: Bearer <secret>`.
 */
export function verifyN8nBackendAuth(request: NextRequest): boolean {
  const configuredSecret = process.env.N8N_WEBHOOK_SECRET?.trim() || '';
  if (!configuredSecret || configuredSecret.includes('replace_with_') || configuredSecret.includes('your_n8n')) {
    // Allow local dev/test mode when placeholder secret is unset
    return process.env.NODE_ENV !== 'production';
  }

  const headerSecret =
    request.headers.get('x-n8n-webhook-secret')?.trim() ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    '';

  if (!headerSecret) return false;
  return safeTimingEqual(headerSecret, configuredSecret);
}

/**
 * Strips credentials, bearer tokens, API keys, and auth headers before persisting or logging errors.
 */
export function sanitizeIntegrationErrorMessage(input: string): string {
  return String(input || 'Unknown integration error')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(x-auth-token|api-subscription-key|x-n8n-webhook-secret|authorization)\s*[:=]\s*[^\s,;"]+/gi, '$1=[REDACTED]')
    .replace(/(sk_[A-Za-z0-9_-]{8,}|sb_secret_[A-Za-z0-9_-]{8,}|MA_[A-Za-z0-9_-]{6,})/g, '[REDACTED]')
    .slice(0, 1000);
}

export async function getServerAutomationSupabaseClient() {
  const env = getRuntimeEnv();
  if (env.isSupabaseConfigured && env.supabaseSecretKey) {
    return createServiceRoleSupabaseClient();
  }
  const user = verifyPilotFounderCookieValue(
    createPilotFounderCookieValue(env.founderLoginEmail)
  )!;
  return createLocalPilotSupabaseClient(user);
}
