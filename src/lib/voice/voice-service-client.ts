import crypto from 'node:crypto';
import { getRuntimeEnv } from '@/lib/env';

export interface SignedVoiceDispatchPayload {
  workspaceId: string;
  actorUserId: string;
  attemptId: string;
  leadId: string;
  phoneE164: string;
}

export function signInternalVoicePayload(rawBody: string, sharedSecret?: string): string {
  const secret =
    sharedSecret ||
    process.env.VOICE_INTERNAL_SHARED_SECRET?.trim() ||
    'nila-default-internal-secret-change-in-prod';
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Calls the deployed Cloud Run Nila Voice service (`VOICE_PUBLIC_BASE_URL/internal/dial`)
 * using a server-side HMAC-SHA256 signed request.
 */
export async function dispatchAuthenticatedCallToVoiceService(
  payload: SignedVoiceDispatchPayload,
  baseUrlOverride?: string
): Promise<{
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}> {
  const env = getRuntimeEnv();
  const baseUrl = (baseUrlOverride || env.voicePublicBaseUrl).replace(/\/+$/, '');
  const rawBody = JSON.stringify(payload);
  const signature = signInternalVoicePayload(rawBody);

  const response = await fetch(`${baseUrl}/internal/dial`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nila-internal-signature': signature,
    },
    body: rawBody,
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

