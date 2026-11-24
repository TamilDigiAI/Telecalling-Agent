import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  chunkPcm16ForVobizPlayAudio,
  computePcm16Rms,
  convertIncomingVobizAudioToSarvamPcm16k,
  parseWavAndStripHeader,
} from './vobiz-audio';

export interface VoiceRuntimeConfig {
  port: number;
  host: string;
  voicePublicBaseUrl: string;
  callbackSigningSecret: string;
  internalSharedSecret: string;
  vobizAuthId: string;
  vobizAuthToken: string;
  vobizPhoneNumber: string;
  vobizApiBaseUrl: string;
  exotelApiKey: string;
  exotelApiToken: string;
  outboundDialingEnabled: boolean;
  sheetsQueueEnabled: boolean;
}

export function getVoiceRuntimeConfig(): VoiceRuntimeConfig {
  const port = Number(process.env.PORT || 8080);
  return {
    port,
    host: '0.0.0.0',
    voicePublicBaseUrl: (
      process.env.VOICE_PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`
    ).replace(/\/+$/, ''),
    callbackSigningSecret:
      process.env.VOICE_CALLBACK_SIGNING_SECRET?.trim() ||
      'nila-default-callback-secret-change-in-prod',
    internalSharedSecret:
      process.env.VOICE_INTERNAL_SHARED_SECRET?.trim() ||
      'nila-default-internal-secret-change-in-prod',
    vobizAuthId: process.env.VOBIZ_AUTH_ID?.trim() || '',
    vobizAuthToken: process.env.VOBIZ_AUTH_TOKEN?.trim() || '',
    vobizPhoneNumber: process.env.VOBIZ_PHONE_NUMBER?.trim() || '',
    vobizApiBaseUrl: (process.env.VOBIZ_API_BASE_URL?.trim() || 'https://api.vobiz.ai').replace(
      /\/+$/,
      ''
    ),
    exotelApiKey: process.env.EXOTEL_API_KEY?.trim() || '',
    exotelApiToken: process.env.EXOTEL_API_TOKEN?.trim() || '',
    outboundDialingEnabled: process.env.OUTBOUND_DIALING_ENABLED === 'true',
    sheetsQueueEnabled: process.env.SHEETS_QUEUE_ENABLED === 'true',
  };
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'no-answer',
  'no_answer',
  'busy',
  'failed',
  'canceled',
  'cancelled',
  'insufficient-balance',
  'insufficient_balance',
  'rejected',
  'hangup',
]);

export function computeAttemptCallbackToken(attemptId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`attempt:${attemptId}`).digest('hex');
}

export function computeVobizCallbackToken(
  attemptId: string,
  accountId: string,
  secret: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`vobiz:${accountId}:attempt:${attemptId}`)
    .digest('hex');
}

export function computeInternalRequestSignature(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface AttemptStateRecord {
  attemptId: string;
  workspaceId?: string;
  accountId?: string;
  provider?: 'vobiz' | 'exotel';
  callSid?: string;
  streamId?: string;
  negotiatedContentType?: string;
  negotiatedSampleRate?: number;
  status: string;
  terminal: boolean;
  hangupCause?: string;
  durationSeconds?: number;
  updatedAt: string;
}

export class NilaVoiceRuntimeState {
  public readonly processedEventKeys = new Set<string>();
  public readonly attempts = new Map<string, AttemptStateRecord>();
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCallbackPayload(
  rawBody: string,
  contentType: string
): Record<string, unknown> | null {
  if (!rawBody.trim()) return {};
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body: Record<string, unknown> = {};
      const params = new URLSearchParams(rawBody);
      params.forEach((v, k) => {
        body[k] = v;
      });
      return body;
    }
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendXml(res: ServerResponse, statusCode: number, xml: string) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(xml);
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function verifyExotelAuth(
  req: IncomingMessage,
  urlObj: URL,
  attemptId: string,
  cfg: VoiceRuntimeConfig
): boolean {
  if (!attemptId) return false;

  const queryToken = urlObj.searchParams.get('token') || '';
  const headerToken =
    (req.headers['x-exotel-callback-token'] as string) ||
    (req.headers['x-exotel-stream-token'] as string) ||
    '';
  const candidateToken = queryToken || headerToken;
  const expectedToken = computeAttemptCallbackToken(attemptId, cfg.callbackSigningSecret);

  if (candidateToken && safeTimingEqual(candidateToken, expectedToken)) {
    return true;
  }

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ') && cfg.exotelApiKey && cfg.exotelApiToken) {
    const expectedBasic = Buffer.from(`${cfg.exotelApiKey}:${cfg.exotelApiToken}`).toString(
      'base64'
    );
    const providedBasic = authHeader.slice('Basic '.length).trim();
    if (safeTimingEqual(providedBasic, expectedBasic)) {
      return true;
    }
  }

  return false;
}

/**
 * Verifies Vobiz HTTP callbacks and WebSocket upgrades via:
 * 1) Vobiz HMAC-SHA256 signature header (X-Vobiz-Signature / V2 / V3) using VOBIZ_AUTH_TOKEN, OR
 * 2) Attempt + Account bound HMAC token (`?attemptId=...&accountId=...&token=...`) signed with VOICE_CALLBACK_SIGNING_SECRET.
 * Also enforces accountId binding when VOBIZ_AUTH_ID is configured.
 */
export function verifyVobizAuth(
  req: IncomingMessage,
  urlObj: URL,
  attemptId: string,
  rawBody: string,
  cfg: VoiceRuntimeConfig
): { ok: boolean; accountId: string; reason?: string } {
  if (!attemptId) {
    return { ok: false, accountId: '', reason: 'Missing attemptId' };
  }

  const queryAccountId = (urlObj.searchParams.get('accountId') || '').trim();
  const headerAccountId = String(req.headers['x-auth-id'] || '').trim();
  const expectedAccount = cfg.vobizAuthId || queryAccountId || 'vobiz';

  // Enforce strict account binding if VOBIZ_AUTH_ID is configured on the server
  if (cfg.vobizAuthId) {
    if (queryAccountId && queryAccountId !== cfg.vobizAuthId) {
      return { ok: false, accountId: queryAccountId, reason: 'Account mismatch' };
    }
    if (headerAccountId && headerAccountId !== cfg.vobizAuthId) {
      return { ok: false, accountId: headerAccountId, reason: 'Header account mismatch' };
    }
  }

  // 1. Check Vobiz HMAC-SHA256 signature header when VOBIZ_AUTH_TOKEN is configured
  const sigHeader = String(
    req.headers['x-vobiz-signature'] ||
      req.headers['x-vobiz-signature-v3'] ||
      req.headers['x-vobiz-signature-v2'] ||
      ''
  ).trim();
  if (sigHeader && cfg.vobizAuthToken) {
    const expectedHex = crypto
      .createHmac('sha256', cfg.vobizAuthToken)
      .update(rawBody)
      .digest('hex');
    const expectedB64 = crypto
      .createHmac('sha256', cfg.vobizAuthToken)
      .update(rawBody)
      .digest('base64');
    if (safeTimingEqual(sigHeader, expectedHex) || safeTimingEqual(sigHeader, expectedB64)) {
      return { ok: true, accountId: expectedAccount };
    }
  }

  // 2. Check attempt + account bound HMAC token
  const candidateToken =
    (urlObj.searchParams.get('token') || '').trim() ||
    String(req.headers['x-vobiz-callback-token'] || '').trim();
  const expectedToken = computeVobizCallbackToken(
    attemptId,
    expectedAccount,
    cfg.callbackSigningSecret
  );
  if (candidateToken && safeTimingEqual(candidateToken, expectedToken)) {
    return { ok: true, accountId: expectedAccount };
  }

  return { ok: false, accountId: expectedAccount, reason: 'Invalid Vobiz signature or token' };
}

/**
 * Generates Vobiz documented bidirectional <Stream> XML for the Answer endpoint.
 */
export function buildVobizAnswerStreamXml(params: {
  voicePublicBaseUrl: string;
  attemptId: string;
  accountId: string;
  token: string;
  contentType?: string;
}): string {
  const base = params.voicePublicBaseUrl.replace(/\/+$/, '');
  const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  const qs = `attemptId=${encodeURIComponent(params.attemptId)}&accountId=${encodeURIComponent(
    params.accountId
  )}&token=${encodeURIComponent(params.token)}`;
  const wssUrl = `${wsBase}/vobiz/stream?${qs}`;
  const statusCallbackUrl = `${base}/vobiz/stream-status?${qs}`;
  const contentType = params.contentType || 'audio/x-l16;rate=16000';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="${escapeXmlAttr(
      contentType
    )}" statusCallbackUrl="${escapeXmlAttr(statusCallbackUrl)}">${escapeXmlAttr(wssUrl)}</Stream>`,
    '</Response>',
  ].join('\n');
}

/**
 * Encodes a text frame according to RFC 6455 WebSocket protocol.
 */
export function encodeWebSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Decodes a client-to-server masked RFC 6455 WebSocket frame and returns total bytes consumed.
 */
export function decodeWebSocketFrame(
  buf: Buffer
): { opcode: number; payload: Buffer; bytesConsumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const isMasked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey: Buffer | null = null;
  if (isMasked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + payloadLen) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { opcode, payload, bytesConsumed: offset + payloadLen };
}

function normalizeVobizStatus(rawStatus: string, hangupCause = ''): string {
  const combined = `${rawStatus} ${hangupCause}`.toLowerCase();
  if (combined.includes('insufficient') || combined.includes('balance')) {
    return 'insufficient_balance';
  }
  if (combined.includes('busy')) return 'busy';
  if (combined.includes('no-answer') || combined.includes('no_answer') || combined.includes('no answer')) {
    return 'no-answer';
  }
  if (combined.includes('cancel')) return 'cancelled';
  if (combined.includes('fail') || combined.includes('error') || combined.includes('reject')) {
    return 'failed';
  }
  if (combined.includes('complete') || combined.includes('hangup') || combined.includes('normal_clearing')) {
    return 'completed';
  }
  return rawStatus.trim().toLowerCase() || 'in-progress';
}

export function createNilaVoiceHttpServer(
  customConfig?: Partial<VoiceRuntimeConfig>,
  state: NilaVoiceRuntimeState = new NilaVoiceRuntimeState()
) {
  const cfg: VoiceRuntimeConfig = {
    ...getVoiceRuntimeConfig(),
    ...customConfig,
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // 1. GET /health — MUST contain ONLY service status
    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // 2. POST/GET /vobiz/answer — Return documented bidirectional Stream XML
    if ((method === 'POST' || method === 'GET') && pathname === '/vobiz/answer') {
      const rawBody = method === 'POST' ? await readRawBody(req) : '';
      const body = parseCallbackPayload(rawBody, req.headers['content-type'] || '') || {};
      const attemptId = String(
        urlObj.searchParams.get('attemptId') || body.attemptId || body.CallUUID || ''
      ).trim();

      const auth = verifyVobizAuth(req, urlObj, attemptId, rawBody, cfg);
      if (!auth.ok) {
        sendJson(res, 401, { error: `Unauthorized Vobiz answer callback: ${auth.reason}` });
        return;
      }

      const callUuid = String(body.CallUUID || body.RequestUUID || `vobiz-${attemptId}`).trim();
      const existing = state.attempts.get(attemptId);
      state.attempts.set(attemptId, {
        ...(existing ?? { attemptId, terminal: false }),
        attemptId,
        accountId: auth.accountId,
        provider: 'vobiz',
        callSid: callUuid,
        status: existing?.terminal ? existing.status : 'answered',
        updatedAt: new Date().toISOString(),
      });

      const token = computeVobizCallbackToken(
        attemptId,
        auth.accountId,
        cfg.callbackSigningSecret
      );
      const xml = buildVobizAnswerStreamXml({
        voicePublicBaseUrl: cfg.voicePublicBaseUrl,
        attemptId,
        accountId: auth.accountId,
        token,
        contentType: 'audio/x-l16;rate=16000',
      });
      sendXml(res, 200, xml);
      return;
    }

    // 3. POST /vobiz/hangup, /vobiz/status, /vobiz/stream-status
    if (
      method === 'POST' &&
      (pathname === '/vobiz/hangup' ||
        pathname === '/vobiz/status' ||
        pathname === '/vobiz/stream-status')
    ) {
      const rawBody = await readRawBody(req);
      const body = parseCallbackPayload(rawBody, req.headers['content-type'] || '');
      if (!body) {
        sendJson(res, 400, { error: 'Invalid Vobiz callback payload' });
        return;
      }

      const attemptId = String(
        urlObj.searchParams.get('attemptId') || body.attemptId || body.CallUUID || ''
      ).trim();
      const auth = verifyVobizAuth(req, urlObj, attemptId, rawBody, cfg);
      if (!auth.ok) {
        sendJson(res, 401, { error: `Unauthorized Vobiz callback: ${auth.reason}` });
        return;
      }

      const callUuid = String(
        body.CallUUID || body.RequestUUID || body.call_uuid || `vobiz-${attemptId}`
      ).trim();
      const rawStatus = String(
        body.CallStatus || body.Status || body.StreamStatus || body.Event || (pathname === '/vobiz/hangup' ? 'completed' : 'in-progress')
      );
      const hangupCause = String(body.HangupCause || body.HangupCauseName || body.Error || '');
      const normalizedStatus = normalizeVobizStatus(rawStatus, hangupCause);
      const eventId = String(
        body.EventId ||
          body.event_id ||
          `${pathname}:${callUuid}:${normalizedStatus}:${body.SequenceNumber || '1'}`
      ).trim();
      const dedupeKey = `vobiz:${attemptId}:${eventId}`;

      if (state.processedEventKeys.has(dedupeKey)) {
        sendJson(res, 200, {
          status: 'duplicate_ignored',
          deduplicated: true,
          attemptId,
          callUuid,
        });
        return;
      }

      state.processedEventKeys.add(dedupeKey);
      const existing = state.attempts.get(attemptId);
      const isIncomingTerminal =
        pathname === '/vobiz/hangup' || TERMINAL_STATUSES.has(normalizedStatus);

      if (existing?.terminal && !isIncomingTerminal) {
        sendJson(res, 200, {
          status: 'terminal_preserved',
          deduplicated: false,
          attemptId,
          callUuid,
          currentStatus: existing.status,
        });
        return;
      }

      const durationSeconds = Number(body.Duration ?? body.BillDuration ?? existing?.durationSeconds ?? 0);
      const updated: AttemptStateRecord = {
        ...(existing ?? { attemptId }),
        attemptId,
        accountId: auth.accountId,
        provider: 'vobiz',
        callSid: callUuid,
        streamId: String(body.StreamId || existing?.streamId || '') || undefined,
        status: normalizedStatus,
        terminal: Boolean(existing?.terminal || isIncomingTerminal),
        hangupCause: hangupCause || existing?.hangupCause,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        updatedAt: new Date().toISOString(),
      };
      state.attempts.set(attemptId, updated);

      sendJson(res, 200, {
        status: 'accepted',
        deduplicated: false,
        provider: 'vobiz',
        attemptId,
        accountId: auth.accountId,
        callUuid,
        callStatus: updated.status,
        terminal: updated.terminal,
      });
      return;
    }

    // 4. Legacy POST /exotel/status — Kept for backward compatibility
    if (method === 'POST' && pathname === '/exotel/status') {
      const rawBody = await readRawBody(req);
      const body = parseCallbackPayload(rawBody, req.headers['content-type'] || '');
      if (!body) {
        sendJson(res, 400, { error: 'Invalid callback payload' });
        return;
      }

      const attemptId = String(
        urlObj.searchParams.get('attemptId') ||
          body.attemptId ||
          body.CustomField ||
          ''
      ).trim();

      if (!verifyExotelAuth(req, urlObj, attemptId, cfg)) {
        sendJson(res, 401, { error: 'Unauthorized Exotel status callback' });
        return;
      }

      const callSid = String(body.CallSid || body.call_sid || `sid-${attemptId}`).trim();
      const rawStatus = String(body.Status || body.CallStatus || body.status || 'in-progress')
        .trim()
        .toLowerCase();
      const eventId = String(
        body.EventId || body.event_id || `${callSid}:${rawStatus}:${body.SequenceNumber || '1'}`
      ).trim();
      const dedupeKey = `${attemptId}:${eventId}`;

      if (state.processedEventKeys.has(dedupeKey)) {
        sendJson(res, 200, {
          status: 'duplicate_ignored',
          deduplicated: true,
          attemptId,
          callSid,
        });
        return;
      }

      state.processedEventKeys.add(dedupeKey);
      const existing = state.attempts.get(attemptId);
      const isIncomingTerminal = TERMINAL_STATUSES.has(rawStatus);

      if (existing?.terminal && !isIncomingTerminal) {
        sendJson(res, 200, {
          status: 'terminal_preserved',
          deduplicated: false,
          attemptId,
          callSid,
          currentStatus: existing.status,
        });
        return;
      }

      const updated: AttemptStateRecord = {
        attemptId,
        provider: 'exotel',
        callSid,
        status: rawStatus,
        terminal: Boolean(existing?.terminal || isIncomingTerminal),
        updatedAt: new Date().toISOString(),
      };
      state.attempts.set(attemptId, updated);

      sendJson(res, 200, {
        status: 'accepted',
        deduplicated: false,
        attemptId,
        callSid,
        callStatus: updated.status,
        terminal: updated.terminal,
      });
      return;
    }

    // 5. POST /internal/dial — Server-authenticated & workspace-authorized dial initiation route
    if (method === 'POST' && pathname === '/internal/dial') {
      const rawBody = await readRawBody(req);
      const signature = String(req.headers['x-nila-internal-signature'] || '').trim();
      const expectedSig = computeInternalRequestSignature(rawBody, cfg.internalSharedSecret);

      if (!signature || !safeTimingEqual(signature, expectedSig)) {
        sendJson(res, 401, { error: 'Unauthorized: invalid internal signature' });
        return;
      }

      let payload: {
        workspaceId?: string;
        actorUserId?: string;
        attemptId?: string;
        leadId?: string;
        phoneE164?: string;
      } = {};
      try {
        payload = JSON.parse(rawBody);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (!payload.workspaceId || !payload.actorUserId || !payload.attemptId) {
        sendJson(res, 403, {
          error: 'Forbidden: workspaceId, actorUserId, and attemptId are required',
        });
        return;
      }

      if (!cfg.outboundDialingEnabled) {
        sendJson(res, 200, {
          status: 'dial_disabled_in_pilot_guard',
          outboundDialingEnabled: false,
          sheetsQueueEnabled: cfg.sheetsQueueEnabled,
          attemptId: payload.attemptId,
          workspaceId: payload.workspaceId,
        });
        return;
      }

      state.attempts.set(payload.attemptId, {
        attemptId: payload.attemptId,
        workspaceId: payload.workspaceId,
        accountId: cfg.vobizAuthId || undefined,
        provider: 'vobiz',
        status: 'initiated',
        terminal: false,
        updatedAt: new Date().toISOString(),
      });

      sendJson(res, 200, {
        status: 'initiated',
        provider: 'vobiz',
        attemptId: payload.attemptId,
        workspaceId: payload.workspaceId,
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  // 6. WebSocket upgrade at /vobiz/stream (primary) and /exotel/media (legacy)
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const isVobizStream = urlObj.pathname === '/vobiz/stream';
    const isExotelMedia = urlObj.pathname === '/exotel/media';

    if (!isVobizStream && !isExotelMedia) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const attemptId = String(urlObj.searchParams.get('attemptId') || '').trim();
    let boundAccountId = cfg.vobizAuthId || 'vobiz';

    if (isVobizStream) {
      const auth = verifyVobizAuth(req, urlObj, attemptId, '', cfg);
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      boundAccountId = auth.accountId;
    } else if (!verifyExotelAuth(req, urlObj, attemptId, cfg)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey || typeof wsKey !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        '',
      ].join('\r\n')
    );

    if (isVobizStream) {
      let streamId = '';
      let negotiatedContentType = 'audio/x-l16';
      let negotiatedSampleRate = 16000;
      let agentSpeaking = false;
      let silentFrameCount = 0;

      socket.write(
        encodeWebSocketTextFrame(
          JSON.stringify({
            event: 'session_bound',
            provider: 'vobiz',
            attemptId,
            accountId: boundAccountId,
            agent: 'Nila',
            voice: 'ritu',
          })
        )
      );

      let rxBuffer = Buffer.alloc(0);

      socket.on('data', (chunk: Buffer) => {
        rxBuffer = Buffer.concat([rxBuffer, chunk]);
        while (rxBuffer.length >= 2) {
          const decoded = decodeWebSocketFrame(rxBuffer);
          if (!decoded) break;
          rxBuffer = rxBuffer.subarray(decoded.bytesConsumed);

          if (decoded.opcode === 0x08) {
            socket.end();
            return;
          }
          if (decoded.opcode !== 0x01) continue;

          try {
            const msg = JSON.parse(decoded.payload.toString('utf8')) as {
              event?: string;
              streamId?: string;
              start?: {
                streamId?: string;
                callId?: string;
                accountId?: string;
                mediaFormat?: {
                  encoding?: string;
                  contentType?: string;
                  sampleRate?: number;
                };
              };
              media?: {
                payload?: string;
                contentType?: string;
                sampleRate?: number;
              };
              wavBase64?: string;
            };

            if (msg.event === 'start') {
              streamId = msg.start?.streamId || msg.streamId || `stream-${attemptId}`;
              const fmt = msg.start?.mediaFormat;
              negotiatedContentType = fmt?.contentType || fmt?.encoding || 'audio/x-l16';
              negotiatedSampleRate = Number(fmt?.sampleRate || 16000);

              const existing = state.attempts.get(attemptId);
              state.attempts.set(attemptId, {
                ...(existing ?? { attemptId, status: 'in-progress', terminal: false }),
                attemptId,
                accountId: boundAccountId,
                provider: 'vobiz',
                streamId,
                negotiatedContentType,
                negotiatedSampleRate,
                status: existing?.terminal ? existing.status : 'in-progress',
                updatedAt: new Date().toISOString(),
              });

              socket.write(
                encodeWebSocketTextFrame(
                  JSON.stringify({
                    event: 'ack',
                    receivedEvent: 'start',
                    attemptId,
                    streamId,
                    negotiatedContentType,
                    negotiatedSampleRate,
                  })
                )
              );
            } else if (msg.event === 'media' && msg.media?.payload) {
              const rawBytes = Buffer.from(msg.media.payload, 'base64');
              const pcm16k = convertIncomingVobizAudioToSarvamPcm16k(
                rawBytes,
                msg.media.contentType || negotiatedContentType,
                Number(msg.media.sampleRate || negotiatedSampleRate)
              );
              const rms = computePcm16Rms(pcm16k);

              if (rms > 0.04) {
                silentFrameCount = 0;
                if (agentSpeaking) {
                  agentSpeaking = false;
                  socket.write(
                    encodeWebSocketTextFrame(
                      JSON.stringify({
                        event: 'clearAudio',
                        streamId,
                      })
                    )
                  );
                }
              } else {
                silentFrameCount += 1;
              }

              socket.write(
                encodeWebSocketTextFrame(
                  JSON.stringify({
                    event: 'media_processed',
                    attemptId,
                    streamId,
                    sarvamPcm16kBytes: pcm16k.length,
                    rms: Number(rms.toFixed(4)),
                    silenceDetected: silentFrameCount >= 250,
                  })
                )
              );
            } else if (msg.event === 'barge_in' || msg.event === 'speech_started') {
              agentSpeaking = false;
              socket.write(
                encodeWebSocketTextFrame(
                  JSON.stringify({
                    event: 'clearAudio',
                    streamId: msg.streamId || streamId,
                  })
                )
              );
            } else if (msg.event === 'send_tts_wav' && msg.wavBase64) {
              const wavBuf = Buffer.from(msg.wavBase64, 'base64');
              const { pcm, sampleRate } = parseWavAndStripHeader(wavBuf);
              const chunks = chunkPcm16ForVobizPlayAudio(pcm, sampleRate, 40);
              agentSpeaking = true;
              for (const c of chunks) {
                if (!agentSpeaking) break;
                socket.write(
                  encodeWebSocketTextFrame(
                    JSON.stringify({
                      event: 'playAudio',
                      streamId: msg.streamId || streamId,
                      media: {
                        contentType: 'audio/x-l16',
                        sampleRate,
                        payload: c.toString('base64'),
                      },
                    })
                  )
                );
              }
            } else if (msg.event === 'clearedAudio') {
              agentSpeaking = false;
            } else if (msg.event === 'stop') {
              agentSpeaking = false;
              socket.end();
              return;
            }
          } catch {
            // Ignore malformed non-JSON frame
          }
        }
      });

      return;
    }

    // Legacy Exotel WebSocket handler
    socket.write(
      encodeWebSocketTextFrame(
        JSON.stringify({
          event: 'session_bound',
          attemptId,
          agent: 'Nila',
        })
      )
    );

    socket.on('data', (chunk: Buffer) => {
      const decoded = decodeWebSocketFrame(chunk);
      if (!decoded) return;
      if (decoded.opcode === 0x08) {
        socket.end();
        return;
      }
      if (decoded.opcode === 0x01) {
        try {
          const msg = JSON.parse(decoded.payload.toString('utf8')) as {
            event?: string;
            stream_sid?: string;
            sequence_number?: number;
          };
          if (msg.event === 'start' || msg.event === 'media' || msg.event === 'connected') {
            socket.write(
              encodeWebSocketTextFrame(
                JSON.stringify({
                  event: 'ack',
                  attemptId,
                  receivedEvent: msg.event,
                  streamSid: msg.stream_sid ?? null,
                })
              )
            );
          } else if (msg.event === 'barge_in' || msg.event === 'speech_started') {
            socket.write(
              encodeWebSocketTextFrame(
                JSON.stringify({
                  event: 'clear',
                  attemptId,
                  streamSid: msg.stream_sid ?? null,
                  reason: 'caller_barge_in',
                })
              )
            );
          } else if (msg.event === 'stop') {
            socket.end();
          }
        } catch {
          // Ignore malformed non-JSON frame
        }
      }
    });
  });

  return { server, state, config: cfg };
}

if (require.main === module) {
  const { server, config } = createNilaVoiceHttpServer();
  server.listen(config.port, config.host, () => {
    console.log(
      `Nila Voice service (Vobiz + Sarvam Ritu) listening on http://${config.host}:${config.port}`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down Nila Voice service gracefully...`);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
