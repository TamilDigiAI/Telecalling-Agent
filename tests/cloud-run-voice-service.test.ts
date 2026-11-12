import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  computeAttemptCallbackToken,
  computeInternalRequestSignature,
  createNilaVoiceHttpServer,
  decodeWebSocketFrame,
} from '../services/nila-voice/src/server';

const TEST_CALLBACK_SECRET = 'test-callback-secret-32-bytes-hex-001';
const TEST_INTERNAL_SECRET = 'test-internal-secret-32-bytes-hex-002';

function createMaskedClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = Buffer.alloc(2 + 4);
  header[0] = 0x81; // FIN + text
  header[1] = 0x80 | payload.length;
  maskKey.copy(header, 2);

  const maskedPayload = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    maskedPayload[i] = payload[i] ^ maskKey[i % 4];
  }
  return Buffer.concat([header, maskedPayload]);
}

async function invokeHttpHandler(
  server: ReturnType<typeof createNilaVoiceHttpServer>['server'],
  options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const reqStream = new PassThrough() as unknown as IncomingMessage;
  reqStream.method = options.method;
  reqStream.url = options.url;
  reqStream.headers = {
    host: 'nila-voice.a.run.app',
    ...(options.headers ?? {}),
  };

  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const chunks: Buffer[] = [];
    const resMock = {
      writeHead(code: number) {
        statusCode = code;
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: statusCode,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
      },
    } as unknown as ServerResponse;

    try {
      server.emit('request', reqStream, resMock);
      if (options.body) {
        (reqStream as unknown as PassThrough).write(options.body);
      }
      (reqStream as unknown as PassThrough).end();
    } catch (err) {
      reject(err);
    }
  });
}

describe('Cloud Run Nila Voice Service (services/nila-voice) · Health, Exotel Callbacks, WSS & Signed CRM Dispatch', () => {
  const { server } = createNilaVoiceHttpServer({
    port: 8080,
    callbackSigningSecret: TEST_CALLBACK_SECRET,
    internalSharedSecret: TEST_INTERNAL_SECRET,
    outboundDialingEnabled: false,
    sheetsQueueEnabled: false,
  });

  it('GET /health returns 200 and contains ONLY service status', async () => {
    const res = await invokeHttpHandler(server, {
      method: 'GET',
      url: '/health',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  it('POST /exotel/status validates token, binds to call attempt, deduplicates replays, and prevents terminal regression', async () => {
    const attemptId = 'attempt-exo-001';
    const validToken = computeAttemptCallbackToken(attemptId, TEST_CALLBACK_SECRET);

    // 1. Unsigned / invalid token is rejected with 401
    const unauthRes = await invokeHttpHandler(server, {
      method: 'POST',
      url: `/exotel/status?attemptId=${attemptId}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CallSid: 'exo-sid-1', Status: 'ringing', EventId: 'ev-1' }),
    });
    expect(unauthRes.status).toBe(401);

    // 2. Authenticated status callback is accepted and bound to attemptId
    const firstRes = await invokeHttpHandler(server, {
      method: 'POST',
      url: `/exotel/status?attemptId=${attemptId}&token=${validToken}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CallSid: 'exo-sid-1', Status: 'completed', EventId: 'ev-1' }),
    });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body).toMatchObject({
      status: 'accepted',
      deduplicated: false,
      attemptId,
      callSid: 'exo-sid-1',
      callStatus: 'completed',
      terminal: true,
    });

    // 3. Replaying the exact same event is deduplicated
    const replayRes = await invokeHttpHandler(server, {
      method: 'POST',
      url: `/exotel/status?attemptId=${attemptId}&token=${validToken}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CallSid: 'exo-sid-1', Status: 'completed', EventId: 'ev-1' }),
    });
    expect(replayRes.status).toBe(200);
    expect(replayRes.body).toMatchObject({
      status: 'duplicate_ignored',
      deduplicated: true,
      attemptId,
    });

    // 4. Out-of-order non-terminal event after completed does not regress terminal status
    const outOfOrderRes = await invokeHttpHandler(server, {
      method: 'POST',
      url: `/exotel/status?attemptId=${attemptId}&token=${validToken}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CallSid: 'exo-sid-1', Status: 'ringing', EventId: 'ev-0-late' }),
    });
    expect(outOfOrderRes.status).toBe(200);
    expect(outOfOrderRes.body).toMatchObject({
      status: 'terminal_preserved',
      currentStatus: 'completed',
    });
  });

  it('WebSocket upgrade at /exotel/media rejects unauthorized upgrades and binds authenticated media streams', async () => {
    const attemptId = 'attempt-ws-002';
    const validToken = computeAttemptCallbackToken(attemptId, TEST_CALLBACK_SECRET);

    // 1. Unauthorized WebSocket upgrade returns HTTP 401
    const unauthSocket = new PassThrough();
    const unauthChunks: Buffer[] = [];
    unauthSocket.on('data', (c) => unauthChunks.push(Buffer.from(c)));

    const unauthReq = {
      url: `/exotel/media?attemptId=${attemptId}`,
      headers: {
        host: 'nila-voice.a.run.app',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      },
    } as unknown as IncomingMessage;

    server.emit('upgrade', unauthReq, unauthSocket, Buffer.alloc(0));
    const unauthText = Buffer.concat(unauthChunks).toString('utf8');
    expect(unauthText).toContain('401 Unauthorized');

    // 2. Authorized WebSocket upgrade succeeds (101 Switching Protocols) and exchanges AgentStream frames
    const authSocket = new PassThrough();
    const outputChunks: Buffer[] = [];
    const origWrite = authSocket.write.bind(authSocket);
    authSocket.write = ((chunk: Buffer | string) => {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return origWrite(chunk);
    }) as typeof authSocket.write;

    const authReq = {
      url: `/exotel/media?attemptId=${attemptId}&token=${validToken}`,
      headers: {
        host: 'nila-voice.a.run.app',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      },
    } as unknown as IncomingMessage;

    server.emit('upgrade', authReq, authSocket, Buffer.alloc(0));
    // Emit a client 'start' WebSocket frame
    authSocket.emit(
      'data',
      createMaskedClientTextFrame(
        JSON.stringify({ event: 'start', stream_sid: 'exo-stream-101' })
      )
    );

    const combined = Buffer.concat(outputChunks);
    const headerEnd = combined.indexOf('\r\n\r\n');
    expect(combined.subarray(0, headerEnd).toString('utf8')).toContain('101 Switching Protocols');

    const frame1Buf = combined.subarray(headerEnd + 4);
    const frame1 = decodeWebSocketFrame(frame1Buf);
    expect(frame1).not.toBeNull();
    const msg1 = JSON.parse(frame1!.payload.toString('utf8'));
    expect(msg1).toEqual({
      event: 'session_bound',
      attemptId,
      agent: 'Nila',
    });

    const frame1TotalLen = 2 + frame1!.payload.length;
    const frame2Buf = frame1Buf.subarray(frame1TotalLen);
    const frame2 = decodeWebSocketFrame(frame2Buf);
    expect(frame2).not.toBeNull();
    const msg2 = JSON.parse(frame2!.payload.toString('utf8'));
    expect(msg2).toEqual({
      event: 'ack',
      attemptId,
      receivedEvent: 'start',
      streamSid: 'exo-stream-101',
    });
  });

  it('POST /internal/dial rejects unsigned requests and accepts HMAC-signed CRM dispatch while keeping dialing disabled in pilot guard', async () => {
    const rawBody = JSON.stringify({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      attemptId: 'att-signed-001',
      leadId: 'lead-001',
      phoneE164: '+919876543210',
    });

    // 1. Unsigned request is blocked with 401
    const unsignedRes = await invokeHttpHandler(server, {
      method: 'POST',
      url: '/internal/dial',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
    expect(unsignedRes.status).toBe(401);

    // 2. Signed request succeeds and confirms outbound dialing & queue remain disabled
    const sig = computeInternalRequestSignature(rawBody, TEST_INTERNAL_SECRET);
    const signedRes = await invokeHttpHandler(server, {
      method: 'POST',
      url: '/internal/dial',
      headers: {
        'content-type': 'application/json',
        'x-nila-internal-signature': sig,
      },
      body: rawBody,
    });
    expect(signedRes.status).toBe(200);
    expect(signedRes.body).toMatchObject({
      status: 'dial_disabled_in_pilot_guard',
      outboundDialingEnabled: false,
      sheetsQueueEnabled: false,
      attemptId: 'att-signed-001',
    });
  });
});
