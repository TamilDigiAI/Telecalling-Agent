import crypto from 'node:crypto';
import { getRuntimeEnv, getServerVobizConfig, isVerifiedVobizHostname } from '@/lib/env';

export interface VobizWebhookUrls {
  answerUrl: string;
  hangupUrl: string;
  statusUrl: string;
  streamStatusUrl: string;
  wssStreamUrl: string;
}

export interface VobizNumberVerificationResult {
  verified: boolean;
  hostVerified: boolean;
  accountId: string;
  phoneNumber: string;
  outboundSupported: boolean;
  balanceInr?: number | null;
  availableBalanceInr?: number | null;
  status?: string;
  error?: string;
}

export interface VobizOutboundCallResult {
  ok: boolean;
  provider: 'vobiz_live';
  requestUuid: string | null;
  apiId: string | null;
  status:
    | 'initiated'
    | 'reconciliation_required'
    | 'insufficient_balance'
    | 'not_configured'
    | 'provider_error';
  httpStatus?: number;
  errorCode?: string;
  message: string;
  reconciliationRequired: boolean;
}

export interface VobizReconciliationResult {
  reconciled: boolean;
  foundOnProvider: boolean;
  requestUuid: string | null;
  callStatus: string | null;
  canRetryDial: boolean;
  message: string;
}

export function computeVobizAttemptToken(
  attemptId: string,
  accountId: string,
  secret?: string
): string {
  const signingSecret =
    secret ||
    process.env.VOICE_CALLBACK_SIGNING_SECRET?.trim() ||
    'nila-default-callback-secret-change-in-prod';
  return crypto
    .createHmac('sha256', signingSecret)
    .update(`vobiz:${accountId}:attempt:${attemptId}`)
    .digest('hex');
}

export function verifyVobizWebhookSignature(
  rawBody: string,
  incomingSignature: string | null | undefined,
  authToken: string
): boolean {
  if (!incomingSignature || !authToken) return false;
  const computedHex = crypto.createHmac('sha256', authToken).update(rawBody).digest('hex');
  const computedB64 = crypto.createHmac('sha256', authToken).update(rawBody).digest('base64');

  const candidate = incomingSignature.trim();
  for (const expected of [computedHex, computedB64]) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

export function buildVobizWebhookUrls(
  voicePublicBaseUrl?: string,
  attemptId?: string,
  accountId?: string
): VobizWebhookUrls {
  const env = getRuntimeEnv();
  const base = (voicePublicBaseUrl || env.voicePublicBaseUrl).replace(/\/+$/, '');
  const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');

  if (!attemptId) {
    return {
      answerUrl: `${base}/vobiz/answer`,
      hangupUrl: `${base}/vobiz/hangup`,
      statusUrl: `${base}/vobiz/status`,
      streamStatusUrl: `${base}/vobiz/stream-status`,
      wssStreamUrl: `${wsBase}/vobiz/stream`,
    };
  }

  const acct = accountId || getServerVobizConfig().authId || 'vobiz';
  const token = computeVobizAttemptToken(attemptId, acct);
  const qs = `attemptId=${encodeURIComponent(attemptId)}&accountId=${encodeURIComponent(acct)}&token=${encodeURIComponent(token)}`;

  return {
    answerUrl: `${base}/vobiz/answer?${qs}`,
    hangupUrl: `${base}/vobiz/hangup?${qs}`,
    statusUrl: `${base}/vobiz/status?${qs}`,
    streamStatusUrl: `${base}/vobiz/stream-status?${qs}`,
    wssStreamUrl: `${wsBase}/vobiz/stream?${qs}`,
  };
}

function normalizeComparableDigits(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

/**
 * Verifies the configured Vobiz host, account balance, and that VOBIZ_PHONE_NUMBER
 * belongs to the Vobiz account and supports outbound voice.
 */
export async function verifyVobizAccountAndNumber(
  fetchImpl: typeof fetch = fetch
): Promise<VobizNumberVerificationResult> {
  const cfg = getServerVobizConfig();
  if (!cfg.hostVerified) {
    return {
      verified: false,
      hostVerified: false,
      accountId: cfg.authId,
      phoneNumber: cfg.phoneNumber,
      outboundSupported: false,
      error: `VOBIZ_API_BASE_URL ("${cfg.apiBaseUrl}") is not a verified https://*.vobiz.ai hostname.`,
    };
  }
  if (!cfg.isConfigured) {
    return {
      verified: false,
      hostVerified: true,
      accountId: cfg.authId,
      phoneNumber: cfg.phoneNumber,
      outboundSupported: false,
      error: 'VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, and VOBIZ_PHONE_NUMBER must be configured on the server.',
    };
  }

  const headers = {
    'X-Auth-ID': cfg.authId,
    'X-Auth-Token': cfg.authToken,
    'Content-Type': 'application/json',
  };

  try {
    const [balRes, numRes] = await Promise.all([
      fetchImpl(`${cfg.apiBaseUrl}/api/v1/Account/${encodeURIComponent(cfg.authId)}/balance/INR`, {
        method: 'GET',
        headers,
      }),
      fetchImpl(`${cfg.apiBaseUrl}/api/v1/Account/${encodeURIComponent(cfg.authId)}/Number/`, {
        method: 'GET',
        headers,
      }),
    ]);

    if (!balRes.ok && !numRes.ok) {
      return {
        verified: false,
        hostVerified: true,
        accountId: cfg.authId,
        phoneNumber: cfg.phoneNumber,
        outboundSupported: false,
        error: `Vobiz API verification failed (balance HTTP ${balRes.status}, numbers HTTP ${numRes.status}).`,
      };
    }

    const balJson = balRes.ok
      ? ((await balRes.json().catch(() => ({}))) as {
          balance?: number;
          available_balance?: number;
          status?: string;
        })
      : {};

    const numJson = numRes.ok
      ? ((await numRes.json().catch(() => ({}))) as {
          objects?: Array<{
            number?: string;
            e164?: string;
            voice_enabled?: boolean;
            status?: string;
          }>;
        })
      : {};

    const targetDigits = normalizeComparableDigits(cfg.phoneNumber);
    const numbers = Array.isArray(numJson.objects) ? numJson.objects : [];
    const matched = numbers.find((n) => {
      const candidate = normalizeComparableDigits(String(n.number || n.e164 || ''));
      return candidate && candidate === targetDigits;
    });

    const outboundSupported = Boolean(matched && matched.voice_enabled !== false);
    return {
      verified: Boolean(matched && outboundSupported),
      hostVerified: true,
      accountId: cfg.authId,
      phoneNumber: cfg.phoneNumber,
      outboundSupported,
      balanceInr: typeof balJson.balance === 'number' ? balJson.balance : null,
      availableBalanceInr:
        typeof balJson.available_balance === 'number' ? balJson.available_balance : null,
      status: balJson.status || matched?.status || 'active',
      error: matched
        ? undefined
        : `Configured VOBIZ_PHONE_NUMBER (${cfg.phoneNumber}) was not found in Vobiz account ${cfg.authId}.`,
    };
  } catch (err) {
    return {
      verified: false,
      hostVerified: true,
      accountId: cfg.authId,
      phoneNumber: cfg.phoneNumber,
      outboundSupported: false,
      error: err instanceof Error ? err.message : 'Vobiz account verification network error',
    };
  }
}

/**
 * Initiates an outbound call via Vobiz's documented Call API:
 *   POST https://api.vobiz.ai/api/v1/Account/{auth_id}/Call/
 * Authenticates with X-Auth-ID and X-Auth-Token.
 * Marks reconciliationRequired=true if the request times out after submission may have succeeded.
 */
export async function initiateVobizOutboundCall(
  params: {
    attemptId: string;
    toPhoneE164: string;
    fromPhoneE164?: string;
    voicePublicBaseUrl?: string;
    timeoutMs?: number;
  },
  fetchImpl: typeof fetch = fetch
): Promise<VobizOutboundCallResult> {
  const cfg = getServerVobizConfig();
  if (!cfg.isConfigured || !isVerifiedVobizHostname(cfg.apiBaseUrl)) {
    return {
      ok: false,
      provider: 'vobiz_live',
      requestUuid: null,
      apiId: null,
      status: 'not_configured',
      message: 'Vobiz credentials or verified api.vobiz.ai hostname not configured.',
      reconciliationRequired: false,
    };
  }

  const from = (params.fromPhoneE164 || cfg.phoneNumber).trim();
  const urls = buildVobizWebhookUrls(params.voicePublicBaseUrl, params.attemptId, cfg.authId);
  const endpoint = `${cfg.apiBaseUrl}/api/v1/Account/${encodeURIComponent(cfg.authId)}/Call/`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 12000);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-ID': cfg.authId,
        'X-Auth-Token': cfg.authToken,
      },
      body: JSON.stringify({
        from,
        to: params.toPhoneE164,
        answer_url: urls.answerUrl,
        answer_method: 'POST',
        hangup_url: urls.hangupUrl,
        ring_url: urls.statusUrl,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const json = (await res.json().catch(() => ({}))) as {
      api_id?: string;
      request_uuid?: string;
      message?: string;
      error?: string;
      code?: string;
    };

    if (res.ok && json.request_uuid) {
      return {
        ok: true,
        provider: 'vobiz_live',
        requestUuid: json.request_uuid,
        apiId: json.api_id ?? null,
        status: 'initiated',
        httpStatus: res.status,
        message: json.message || 'Call fired via Vobiz',
        reconciliationRequired: false,
      };
    }

    const combinedErr = `${json.error || ''} ${json.message || ''}`.toLowerCase();
    const isInsufficientBalance =
      res.status === 402 ||
      combinedErr.includes('balance') ||
      combinedErr.includes('insufficient') ||
      combinedErr.includes('credit');

    return {
      ok: false,
      provider: 'vobiz_live',
      requestUuid: json.request_uuid ?? null,
      apiId: json.api_id ?? null,
      status: isInsufficientBalance ? 'insufficient_balance' : 'provider_error',
      httpStatus: res.status,
      errorCode: json.code || `HTTP_${res.status}`,
      message: json.error || json.message || `Vobiz API returned HTTP ${res.status}`,
      reconciliationRequired: res.status >= 500,
    };
  } catch (err) {
    clearTimeout(timeout);
    const isTimeout =
      err instanceof Error &&
      (err.name === 'AbortError' ||
        err.message.toLowerCase().includes('timeout') ||
        err.message.toLowerCase().includes('etimedout'));

    return {
      ok: false,
      provider: 'vobiz_live',
      requestUuid: null,
      apiId: null,
      status: isTimeout ? 'reconciliation_required' : 'provider_error',
      errorCode: isTimeout ? 'SUBMISSION_TIMEOUT' : 'NETWORK_ERROR',
      message: isTimeout
        ? 'Vobiz call submission timed out; reconciliation is required before retrying dial.'
        : err instanceof Error
          ? err.message
          : 'Vobiz call submission failed',
      reconciliationRequired: true,
    };
  }
}

/**
 * Reconciles a timed-out or ambiguous Vobiz call attempt before allowing another dial.
 */
export async function reconcileVobizCallAttempt(
  params: {
    requestUuid?: string | null;
    toPhoneE164: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<VobizReconciliationResult> {
  const cfg = getServerVobizConfig();
  if (!cfg.isConfigured) {
    return {
      reconciled: false,
      foundOnProvider: false,
      requestUuid: params.requestUuid ?? null,
      callStatus: null,
      canRetryDial: false,
      message: 'Vobiz credentials are not configured; cannot reconcile.',
    };
  }

  const headers = {
    'X-Auth-ID': cfg.authId,
    'X-Auth-Token': cfg.authToken,
    'Content-Type': 'application/json',
  };

  try {
    const url = params.requestUuid
      ? `${cfg.apiBaseUrl}/api/v1/Account/${encodeURIComponent(cfg.authId)}/Call/${encodeURIComponent(params.requestUuid)}/`
      : `${cfg.apiBaseUrl}/api/v1/Account/${encodeURIComponent(cfg.authId)}/Call/?to_number=${encodeURIComponent(params.toPhoneE164)}&limit=5`;

    const res = await fetchImpl(url, { method: 'GET', headers });
    if (res.status === 404) {
      return {
        reconciled: true,
        foundOnProvider: false,
        requestUuid: null,
        callStatus: 'not_found',
        canRetryDial: true,
        message: 'No matching call found on Vobiz; safe to retry dial.',
      };
    }

    if (!res.ok) {
      return {
        reconciled: false,
        foundOnProvider: false,
        requestUuid: params.requestUuid ?? null,
        callStatus: null,
        canRetryDial: false,
        message: `Vobiz reconciliation query failed with HTTP ${res.status}; holding retry.`,
      };
    }

    const json = (await res.json().catch(() => ({}))) as {
      call_uuid?: string;
      request_uuid?: string;
      call_state?: string;
      status?: string;
      objects?: Array<{ call_uuid?: string; request_uuid?: string; call_state?: string; status?: string }>;
    };

    const record = json.objects ? json.objects[0] : json;
    if (!record || (!record.call_uuid && !record.request_uuid)) {
      return {
        reconciled: true,
        foundOnProvider: false,
        requestUuid: null,
        callStatus: 'not_found',
        canRetryDial: true,
        message: 'No active or recent matching call found on Vobiz; safe to retry.',
      };
    }

    const status = String(record.call_state || record.status || 'in-progress').toLowerCase();
    const terminalFailed = ['failed', 'busy', 'no-answer', 'canceled', 'cancelled'].includes(status);

    return {
      reconciled: true,
      foundOnProvider: true,
      requestUuid: record.request_uuid || record.call_uuid || params.requestUuid || null,
      callStatus: status,
      canRetryDial: terminalFailed,
      message: `Reconciled Vobiz call (${status}); retry allowed: ${terminalFailed}.`,
    };
  } catch (err) {
    return {
      reconciled: false,
      foundOnProvider: false,
      requestUuid: params.requestUuid ?? null,
      callStatus: null,
      canRetryDial: false,
      message: err instanceof Error ? err.message : 'Vobiz reconciliation error',
    };
  }
}
