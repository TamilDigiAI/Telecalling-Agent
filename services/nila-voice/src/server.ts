import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';

export interface VoiceRuntimeConfig {
  port: number;
  host: string;
  callbackSigningSecret: string;
  internalSharedSecret: string;
  exotelApiKey: string;
  exotelApiToken: string;
  outboundDialingEnabled: boolean;
  sheetsQueueEnabled: boolean;
}

export function getVoiceRuntimeConfig(): VoiceRuntimeConfig {
  return {
    port: Number(process.env.PORT || 8080),
    host: '0.0.0.0',
    callbackSigningSecret:
      process.env.VOICE_CALLBACK_SIGNING_SECRET?.trim() ||
      'nila-default-callback-secret-change-in-prod',
    internalSharedSecret:
      process.env.VOICE_INTERNAL_SHARED_SECRET?.trim() ||
      'nila-default-internal-secret-change-in-prod',
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
]);

export function computeAttemptCallbackToken(attemptId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`attempt:${attemptId}`).digest('hex');
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
  callSid?: string;
  status: string;
  terminal: boolean;
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

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
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

  // Also support Exotel Basic Auth when EXOTEL_API_KEY and EXOTEL_API_TOKEN are configured
  const authHeader = req.headers.authorization || '';
  if (
    authHeader.startsWith('Basic ') &&
    cfg.exotelApiKey &&
    cfg.exotelApiToken
  ) {
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
 * Decodes a client-to-server masked RFC 6455 WebSocket frame.
 */
export function decodeWebSocketFrame(buf: Buffer): { opcode: number; payload: Buffer } | null {
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

  return { opcode, payload };
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

    // 2. POST /exotel/status — Authenticated, attempt-bound, deduplicated status callback
    if (method === 'POST' && pathname === '/exotel/status') {
      const rawBody = await readRawBody(req);
      let body: Record<string, unknown> = {};
      const contentType = req.headers['content-type'] || '';

      try {
        if (contentType.includes('application/x-www-form-urlencoded')) {
          const params = new URLSearchParams(rawBody);
          params.forEach((v, k) => {
            body[k] = v;
          });
        } else if (rawBody.trim()) {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        }
      } catch {
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
        body.EventId || body.event_id || `${callSid}:${rawStatus}:${ body.SequenceNumber || '1' }`
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

      // Prevent out-of-order delivery from regressing a terminal call status
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

    // 3. POST /internal/dial — Server-authenticated & workspace-authorized dial initiation route
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
        status: 'initiated',
        terminal: false,
        updatedAt: new Date().toISOString(),
      });

      sendJson(res, 200, {
        status: 'initiated',
        attemptId: payload.attemptId,
        workspaceId: payload.workspaceId,
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  // 4. WebSocket upgrade at /exotel/media
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (urlObj.pathname !== '/exotel/media') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const attemptId = String(urlObj.searchParams.get('attemptId') || '').trim();
    if (!verifyExotelAuth(req, urlObj, attemptId, cfg)) {
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
        '\r\n',
      ].join('\r\n')
    );

    // Send bound session acknowledgement
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
      `Nila Voice Cloud Run service listening on http://${config.host}:${config.port}`
    );
  });
}
