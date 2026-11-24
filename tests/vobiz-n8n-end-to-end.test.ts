import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as leadImportPost } from '@/app/api/n8n/lead-import/route';
import { POST as sheetClaimPost } from '@/app/api/n8n/sheet-sync/claim/route';
import { POST as sheetAckPost } from '@/app/api/n8n/sheet-sync/ack/route';
import { POST as integrationErrorPost } from '@/app/api/n8n/integration-errors/route';
import {
  createLocalPilotSupabaseClient,
  createPilotFounderCookieValue,
  PILOT_WORKSPACE_ID,
  verifyPilotFounderCookieValue,
} from '@/lib/supabase/local-pilot-fallback';
import { recordCallOutcomeAndFollowUp } from '@/lib/crm/service';
import { validateStructuredCallOutcome } from '@/lib/voice/qualification-validator';
import { initiateVobizOutboundCall } from '@/lib/telephony/vobiz-client';
import { PILOT_ALLOWLIST_PHONES, PILOT_TEST_CONTACTS } from '@/lib/pilot/test-contacts';
import {
  computeVobizCallbackToken,
  createNilaVoiceHttpServer,
  decodeWebSocketFrame,
} from '../services/nila-voice/src/server';
import {
  convertIncomingVobizAudioToSarvamPcm16k,
  parseWavAndStripHeader,
  pcm16ToUlaw,
  wrapPcm16AsWav,
} from '../services/nila-voice/src/vobiz-audio';

function resetLocalPilotStore() {
  (globalThis as unknown as { __dazLocalPilotStore?: unknown }).__dazLocalPilotStore = undefined;
}

function getLocalClient() {
  const user = verifyPilotFounderCookieValue(
    createPilotFounderCookieValue('pheonixtamil2025@gmail.com')
  )!;
  return createLocalPilotSupabaseClient(user);
}

function makeJsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function encodeMaskedClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

describe('End-to-End 6 Required Journeys (Google Sheets · n8n · Vobiz · Sarvam Ritu · CRM)', () => {
  beforeEach(() => {
    resetLocalPilotStore();
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.N8N_WEBHOOK_SECRET;
  });

  it('Journey 1: Importing the same synthetic lead twice creates exactly 1 call job and flags missing/duplicate IDs', async () => {
    const syntheticRow = {
      row_number: 5,
      'Lead ID': 'DAZ-E2E-001',
      Name: 'Arun Kumar',
      Phone: '9876501234',
      Service: 'Meta Ads for Facebook and Instagram lead generation',
      Source: 'Google Sheet',
      'Calling Eligibility': 'ELIGIBLE',
      'Eligibility Reference': 'CONSENT-ROW-5',
      'Do Not Call': 'FALSE',
    };

    const res1 = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', { rows: [syntheticRow] })
    );
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.callJobsCreated).toBe(1);
    expect(data1.results[0].action).toBe('created');

    // Second import of identical synthetic lead (repeated polling)
    const res2 = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', { rows: [syntheticRow] })
    );
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.callJobsCreated).toBe(0);
    expect(data2.results[0].action).toBe('updated');

    const supabase = getLocalClient();
    const { data: queueJobs } = await supabase
      .from('call_queue_jobs')
      .select('*')
      .eq('workspace_id', PILOT_WORKSPACE_ID);
    expect((queueJobs ?? []).length).toBe(1);

    // Flag missing Lead ID for review without creating a call job
    const resMissing = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', {
        rows: [{ row_number: 6, 'Lead ID': '', Name: 'No ID Lead', Phone: '9876509999' }],
      })
    );
    const missingData = await resMissing.json();
    expect(missingData.flaggedForReviewCount).toBe(1);
    expect(missingData.callJobsCreated).toBe(0);
  });

  it('Journeys 2, 3, 4 & 6: HOT outcome -> 1 callback task -> Sheet RAW write-back -> Recover failed write without redial -> Preserve HOT on NO_ANSWER', async () => {
    const importRes = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', {
        rows: [
          {
            row_number: 7,
            'Lead ID': 'DAZ-E2E-HOT-002',
            Name: 'Priya Sundaram',
            Phone: '9840112233',
            Service: 'Meta Ads',
            Source: 'Google Sheet',
            'Calling Eligibility': 'ELIGIBLE',
          },
        ],
      })
    );
    const importJson = await importRes.json();
    const leadId = importJson.results[0].crmLeadId as string;
    const supabase = getLocalClient();

    // Journey 2: Server-side validation + HOT outcome creates exactly 1 callback task
    const validated = validateStructuredCallOutcome({
      callOutcome: 'CALLBACK_REQUESTED',
      proposedTemperature: 'HOT',
      qualificationReason: 'Active Meta Ads requirement and confirmed tomorrow 11:00 AM IST callback.',
      summary: 'Priya confirmed Meta Ads need and requested founder callback tomorrow 11:00 AM IST.',
      callbackAt: '2026-11-25T11:00:00+05:30',
      need: 'Meta Ads lead generation',
      nextAction: 'Founder callback at 11:00 AM IST',
    });
    expect(validated.appliedTemperature).toBe('HOT');
    expect(validated.downgradedFromHot).toBe(false);

    const outcomeRes = await recordCallOutcomeAndFollowUp(supabase, {
      workspaceId: PILOT_WORKSPACE_ID,
      leadId,
      callOutcome: validated.callOutcome,
      proposedTemperature: validated.appliedTemperature,
      qualificationReason: validated.qualificationReason,
      summary: validated.summary,
      callbackAt: validated.callbackAt,
      structuredExtraction: validated.structuredExtraction,
    });
    expect(outcomeRes.applied_temperature).toBe('HOT');
    expect(outcomeRes.follow_up_task_id).toBeTruthy();
    expect(outcomeRes.sheet_sync_job_id).toBeTruthy();

    const { data: tasks } = await supabase
      .from('follow_up_tasks')
      .select('*')
      .eq('workspace_id', PILOT_WORKSPACE_ID)
      .eq('lead_id', leadId);
    expect((tasks ?? []).length).toBe(1);

    // Journey 4: Claim sync job -> simulate FAILED Sheet write -> verify retryable WITHOUT redial
    const claim1Res = await sheetClaimPost(
      makeJsonPost('http://localhost:3000/api/n8n/sheet-sync/claim', { workerId: 'test-w1' })
    );
    const claim1 = await claim1Res.json();
    expect(claim1.claimedCount).toBe(1);
    expect(claim1.jobs[0].valueInputOption).toBe('RAW');
    expect(claim1.jobs[0].externalLeadId).toBe('DAZ-E2E-HOT-002');
    expect(claim1.jobs[0].automationColumnsJToT['Lead Temperature']).toBe('HOT');

    const failAckRes = await sheetAckPost(
      makeJsonPost('http://localhost:3000/api/n8n/sheet-sync/ack', {
        jobId: claim1.jobs[0].jobId,
        leaseToken: claim1.jobs[0].leaseToken,
        status: 'FAILED',
        error: 'Google Sheets API 503 temporary error',
      })
    );
    const failAck = await failAckRes.json();
    expect(failAck.status).toBe('FAILED');
    expect(failAck.retryable).toBe(true);
    expect(failAck.redialTriggered).toBe(false);

    // Confirm no extra call attempt was created by the failed sheet write
    const { data: attemptsAfterFail } = await supabase
      .from('call_attempts')
      .select('*')
      .eq('workspace_id', PILOT_WORKSPACE_ID)
      .eq('lead_id', leadId);
    expect((attemptsAfterFail ?? []).length).toBe(1);

    // Make retry immediately due & recover via Journey 3 (SUCCEEDED ack)
    await supabase
      .from('sheet_sync_jobs')
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', claim1.jobs[0].jobId);

    const claim2Res = await sheetClaimPost(
      makeJsonPost('http://localhost:3000/api/n8n/sheet-sync/claim', { workerId: 'test-w2' })
    );
    const claim2 = await claim2Res.json();
    expect(claim2.claimedCount).toBe(1);

    const okAckRes = await sheetAckPost(
      makeJsonPost('http://localhost:3000/api/n8n/sheet-sync/ack', {
        jobId: claim2.jobs[0].jobId,
        leaseToken: claim2.jobs[0].leaseToken,
        status: 'SUCCEEDED',
        matchedRowNumber: 7,
      })
    );
    const okAck = await okAckRes.json();
    expect(okAck.status).toBe('SUCCEEDED');
    expect(okAck.redialTriggered).toBe(false);

    // Journey 6: Subsequent NO_ANSWER attempt preserves prior HOT qualification
    const noAnswerRes = await recordCallOutcomeAndFollowUp(supabase, {
      workspaceId: PILOT_WORKSPACE_ID,
      leadId,
      callOutcome: 'NO_ANSWER',
      proposedTemperature: 'UNQUALIFIED',
      qualificationReason: 'Caller did not pick up reminder call.',
      summary: 'No answer on follow-up attempt.',
    });
    expect(noAnswerRes.applied_temperature).toBe('HOT');
  });

  it('Journey 5: Opt-out immediately suppresses contact, cancels queued calls & blocks future dials', async () => {
    const importRes = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', {
        rows: [
          {
            row_number: 8,
            'Lead ID': 'DAZ-E2E-DNC-003',
            Name: 'Suresh K',
            Phone: '9840998877',
            Service: 'SEO',
            Source: 'Google Sheet',
            'Calling Eligibility': 'ELIGIBLE',
          },
        ],
      })
    );
    const leadId = (await importRes.json()).results[0].crmLeadId as string;
    const supabase = getLocalClient();

    await recordCallOutcomeAndFollowUp(supabase, {
      workspaceId: PILOT_WORKSPACE_ID,
      leadId,
      callOutcome: 'DO_NOT_CALL',
      proposedTemperature: 'COLD',
      qualificationReason: 'Requested removal from calling list.',
      summary: 'Caller opted out.',
      optOut: true,
    });

    const { data: qJobs } = await supabase
      .from('call_queue_jobs')
      .select('*')
      .eq('workspace_id', PILOT_WORKSPACE_ID)
      .eq('lead_id', leadId);
    expect((qJobs ?? [])[0]?.status).toBe('CANCELLED');

    await expect(
      recordCallOutcomeAndFollowUp(supabase, {
        workspaceId: PILOT_WORKSPACE_ID,
        leadId,
        callOutcome: 'CONNECTED',
        proposedTemperature: 'WARM',
        qualificationReason: 'Should be blocked',
        summary: 'Should not succeed',
      })
    ).rejects.toThrow(/opted out|DO_NOT_CALL/i);
  });

  it('Vobiz Voice Service: Answer Stream XML, Hangup dedupe, Bidirectional WSS audio conversion & barge-in clearAudio', async () => {
    const secret = 'test-vobiz-callback-secret';
    const authId = 'MA_TEST_ACCOUNT';
    const authToken = 'vobiz_test_auth_token_123';
    const { server } = createNilaVoiceHttpServer({
      voicePublicBaseUrl: 'https://voice.digianchorz.test',
      callbackSigningSecret: secret,
      vobizAuthId: authId,
      vobizAuthToken: authToken,
      outboundDialingEnabled: true,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const attemptId = 'att-vobiz-101';
      const token = computeVobizCallbackToken(attemptId, authId, secret);

      // Unauthorized answer rejected
      const unauth = await fetch(`http://127.0.0.1:${port}/vobiz/answer?attemptId=${attemptId}`, {
        method: 'POST',
      });
      expect(unauth.status).toBe(401);

      // Authorized answer returns documented bidirectional Stream XML
      const ans = await fetch(
        `http://127.0.0.1:${port}/vobiz/answer?attemptId=${attemptId}&accountId=${authId}&token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ CallUUID: 'vobiz-uuid-101' }),
        }
      );
      expect(ans.status).toBe(200);
      const xml = await ans.text();
      expect(xml).toContain('<Stream');
      expect(xml).toContain('bidirectional="true"');
      expect(xml).toContain('keepCallAlive="true"');
      expect(xml).toContain('wss://voice.digianchorz.test/vobiz/stream');

      // Hangup deduplication & terminal status preservation
      const hangupBody = JSON.stringify({
        CallUUID: 'vobiz-uuid-101',
        CallStatus: 'completed',
        Duration: '42',
        EventId: 'evt-hangup-1',
      });
      const sig = crypto.createHmac('sha256', authToken).update(hangupBody).digest('hex');
      const h1 = await fetch(
        `http://127.0.0.1:${port}/vobiz/hangup?attemptId=${attemptId}&accountId=${authId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-vobiz-signature': sig },
          body: hangupBody,
        }
      );
      expect((await h1.json()).status).toBe('accepted');

      const h2 = await fetch(
        `http://127.0.0.1:${port}/vobiz/hangup?attemptId=${attemptId}&accountId=${authId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-vobiz-signature': sig },
          body: hangupBody,
        }
      );
      expect((await h2.json()).deduplicated).toBe(true);

      // Verify audio conversion: 8kHz mu-law -> 16kHz PCM16 for Sarvam, and 24kHz WAV header stripping
      const pcm8k = Buffer.alloc(160 * 2); // 20ms at 8kHz
      pcm8k.writeInt16LE(12000, 0);
      const ulaw = pcm16ToUlaw(pcm8k);
      const sarvam16k = convertIncomingVobizAudioToSarvamPcm16k(ulaw, 'audio/x-mulaw', 8000);
      expect(sarvam16k.length).toBe(320 * 2); // 20ms at 16kHz

      const wav24k = wrapPcm16AsWav(Buffer.alloc(960 * 2), 24000);
      const stripped = parseWavAndStripHeader(wav24k);
      expect(stripped.sampleRate).toBe(24000);
      expect(stripped.pcm.length).toBe(960 * 2);

      // WebSocket /vobiz/stream: start -> playAudio -> barge_in -> clearAudio
      const wsEvents = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const duplex = new PassThrough();
        const serverOut: Buffer[] = [];
        const origWrite = duplex.write.bind(duplex);
        // Intercept server writes while letting test push client frames via duplex.emit('data', ...)
        duplex.write = ((chunk: unknown) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          serverOut.push(buf);
          return true;
        }) as typeof duplex.write;

        const upgradeReq = {
          url: `/vobiz/stream?attemptId=${attemptId}&accountId=${authId}&token=${token}`,
          headers: {
            host: `127.0.0.1:${port}`,
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
            'sec-websocket-version': '13',
          },
        } as unknown as IncomingMessage;

        server.emit('upgrade', upgradeReq, duplex, Buffer.alloc(0));

        // Send Vobiz start, TTS WAV playback, and barge-in frames
        duplex.emit(
          'data',
          encodeMaskedClientTextFrame(
            JSON.stringify({
              event: 'start',
              start: {
                streamId: 'str-101',
                mediaFormat: { contentType: 'audio/x-l16', sampleRate: 16000 },
              },
            })
          )
        );
        duplex.emit(
          'data',
          encodeMaskedClientTextFrame(
            JSON.stringify({
              event: 'send_tts_wav',
              streamId: 'str-101',
              wavBase64: wav24k.toString('base64'),
            })
          )
        );
        duplex.emit(
          'data',
          encodeMaskedClientTextFrame(
            JSON.stringify({ event: 'barge_in', streamId: 'str-101' })
          )
        );

        void origWrite;
        const combined = Buffer.concat(serverOut);
        const headerEnd = combined.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          reject(new Error('Missing HTTP 101 upgrade response'));
          return;
        }
        let rxBuf = combined.subarray(headerEnd + 4);
        const parsedEvents: Array<Record<string, unknown>> = [];
        while (rxBuf.length >= 2) {
          const frame = decodeWebSocketFrame(rxBuf);
          if (!frame) break;
          rxBuf = rxBuf.subarray(frame.bytesConsumed);
          parsedEvents.push(JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>);
        }
        resolve(parsedEvents);
      });

      const playFrame = wsEvents.find((e) => e.event === 'playAudio') as
        | { media?: { contentType?: string; sampleRate?: number } }
        | undefined;
      expect(playFrame?.media?.contentType).toBe('audio/x-l16');
      expect(playFrame?.media?.sampleRate).toBe(24000);
      expect(wsEvents.some((e) => e.event === 'clearAudio')).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Vobiz REST client authenticates with X-Auth-ID/X-Auth-Token and flags timeout for reconciliation', async () => {
    process.env.VOBIZ_AUTH_ID = 'MA_TEST_123';
    process.env.VOBIZ_AUTH_TOKEN = 'secret_tok_123';
    process.env.VOBIZ_PHONE_NUMBER = '+918064264459';
    process.env.VOBIZ_API_BASE_URL = 'https://api.vobiz.ai';

    let capturedHeaders: Record<string, string> = {};
    const mockOkFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({ api_id: 'api-1', request_uuid: 'req-uuid-999', message: 'Call fired' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const okRes = await initiateVobizOutboundCall(
      { attemptId: 'att-1', toPhoneE164: '+916383939949' },
      mockOkFetch
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.requestUuid).toBe('req-uuid-999');
    expect(capturedHeaders['X-Auth-ID']).toBe('MA_TEST_123');
    expect(capturedHeaders['X-Auth-Token']).toBe('secret_tok_123');

    // Timeout marks reconciliationRequired=true
    const mockTimeoutFetch = (async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;

    const timeoutRes = await initiateVobizOutboundCall(
      { attemptId: 'att-2', toPhoneE164: '+916383939949' },
      mockTimeoutFetch
    );
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.reconciliationRequired).toBe(true);

    delete process.env.VOBIZ_AUTH_ID;
    delete process.env.VOBIZ_AUTH_TOKEN;
    delete process.env.VOBIZ_PHONE_NUMBER;
  });

  it('Workflow C sanitizes credentials in integration errors and all 3 n8n workflow JSONs are secret-free', async () => {
    const errRes = await integrationErrorPost(
      makeJsonPost('http://localhost:3000/api/n8n/integration-errors', {
        source: 'n8n',
        workflowName: 'Nila — Sheet Write-back',
        executionId: 'exec-77',
        nodeName: 'Update Columns J:T (RAW)',
        message: 'HTTP 401 failed with Bearer super_secret_token_12345 and x-auth-token=leakme',
      })
    );
    expect(errRes.status).toBe(200);
    const errJson = await errRes.json();
    expect(errJson.errorRecord.sanitized_message).not.toContain('super_secret_token_12345');
    expect(errJson.errorRecord.sanitized_message).not.toContain('leakme');
    expect(errJson.errorRecord.sanitized_message).toContain('[REDACTED]');

    // Validate all 3 generated n8n workflow files
    const workflowFiles = [
      'n8n/nila-lead-intake.json',
      'n8n/nila-sheet-write-back.json',
      'n8n/nila-integration-errors.json',
    ];
    for (const rel of workflowFiles) {
      const fullPath = path.resolve(process.cwd(), rel);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw) as { name: string; nodes: unknown[] };
      expect(parsed.name).toMatch(/^Nila — /);
      expect(parsed.nodes.length).toBeGreaterThanOrEqual(3);
      expect(raw).not.toContain('sk_');
      expect(raw).not.toContain('sb_secret_');
    }
  });

  it('Five Live-Test Contacts (NILA-TEST-001..005): repeated import yields 5 unique contacts, 0 auto-dials, and all 5 allowlisted', async () => {
    const sheetRows = PILOT_TEST_CONTACTS.map((c) => ({
      row_number: c.rowNumber,
      'Lead ID': c.externalLeadId,
      Name: c.fullName,
      Phone: c.rawPhone,
      Service: c.serviceInterest,
      Source: c.source,
      'Calling Eligibility': c.callingEligibility,
      'Eligibility Reference': c.eligibilityReference,
      'Do Not Call': 'FALSE',
    }));

    // Import twice with autoEnqueueCalls: false (pilot manual button-click mode)
    const r1 = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', {
        autoEnqueueCalls: false,
        rows: sheetRows,
      })
    );
    const j1 = await r1.json();
    expect(j1.ok).toBe(true);
    expect(j1.processedCount).toBe(5);
    expect(j1.callJobsCreated).toBe(0);

    const r2 = await leadImportPost(
      makeJsonPost('http://localhost:3000/api/n8n/lead-import', {
        autoEnqueueCalls: false,
        rows: sheetRows,
      })
    );
    const j2 = await r2.json();
    expect(j2.ok).toBe(true);
    expect(j2.callJobsCreated).toBe(0);

    const supabase = getLocalClient();
    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', PILOT_WORKSPACE_ID);
    const testLeads = ((leads ?? []) as Array<{ external_lead_id: string; phone_e164: string; id: string }>).filter((l) =>
      l.external_lead_id.startsWith('NILA-TEST-')
    );
    expect(testLeads.length).toBe(5);

    for (const expected of PILOT_TEST_CONTACTS) {
      const match = testLeads.find((l) => l.external_lead_id === expected.externalLeadId);
      expect(match).toBeTruthy();
      expect(match?.phone_e164).toBe(expected.phoneE164);
    }

    // Verify all 5 numbers are in workspace pilot allowlist
    const { data: ws } = await supabase
      .from('workspaces')
      .select('allowlist_phones')
      .eq('id', PILOT_WORKSPACE_ID)
      .single();
    const allowlist = (ws as { allowlist_phones: string[] }).allowlist_phones;
    for (const phone of PILOT_ALLOWLIST_PHONES) {
      expect(allowlist).toContain(phone);
    }
  });
});
