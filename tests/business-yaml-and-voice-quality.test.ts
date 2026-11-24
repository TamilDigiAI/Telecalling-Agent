import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  buildBusinessYamlSystemPrompt,
  isCallerEnglish,
  loadBusinessYamlConfig,
  SILENCE_10S_MARKER,
} from '@/lib/knowledge/business-yaml';
import {
  generateNilaReplyWithSarvamLlm,
  normalizePhoneDigitsForTts,
  normalizeSpokenTimesForTts,
  prepareTextForNaturalTts,
  toPhoneticTamilForTts,
} from '@/lib/voice/sarvam-nila';
import {
  computeAttemptCallbackToken,
  createNilaVoiceHttpServer,
  decodeWebSocketFrame,
} from '../services/nila-voice/src/server';

function encodeMaskedClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  header[1] = 0x80 | payload.length;
  return Buffer.concat([header, mask, masked]);
}

describe('config/business.yaml grounding, voice quality normalizers & barge-in', () => {
  it('loads and validates config/business.yaml with all DigiAnchorZ facts and 11 services', () => {
    const cfg = loadBusinessYamlConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.business.name).toBe('DigiAnchorZ');
    expect(cfg!.business.address).toBe(
      'Room No 4, 2nd Floor, Vinayaga Complex, Thanthoni, Karur'
    );
    expect(cfg!.business.phone).toBe('094455 81778');
    expect(cfg!.business.website).toBe('digianchorz.com');
    expect(cfg!.services).toEqual([
      'Meta Ads',
      'Google Ads',
      'SEO',
      'social media management',
      'Google Business Profile',
      'website',
      'landing page',
      'video/reels',
      'branding',
      'lead generation',
      'AI agents',
    ]);
    expect(cfg!.pricing.allow_final_price).toBe(false);
    expect(cfg!.pricing.allow_discount).toBe(false);
    expect(cfg!.guarantees.allow_result_guarantee).toBe(false);
    expect(cfg!.timings.booked_slots_tomorrow).toContain('10:00 AM');
    expect(cfg!.timings.free_slots_tomorrow).toContain('11:00 AM');
    expect(cfg!.silence_handling.timeout_seconds).toBe(10);

    const prompt = buildBusinessYamlSystemPrompt(cfg!);
    expect(prompt).toContain('Room No 4, 2nd Floor, Vinayaga Complex, Thanthoni, Karur');
    expect(prompt).toContain('Google Business Profile');
    expect(prompt).toContain('video/reels');
    expect(prompt).toContain('10:00 AM');
    expect(prompt).toContain('11:00 AM');
  });

  it('normalizes clock times, phone digits, Tanglish loanwords, and English language switching for natural TTS', () => {
    // Natural spoken times
    expect(normalizeSpokenTimesForTts('Slot available at 10:30 AM tomorrow', 'english')).toBe(
      'Slot available at ten thirty AM tomorrow'
    );
    expect(normalizeSpokenTimesForTts('நாளைக்கு 10:30 AM slot இருக்கு', 'tamil')).toBe(
      'நாளைக்கு டென் தர்ட்டி ஏ எம் slot இருக்கு'
    );

    // Digit-by-digit phone readback
    expect(normalizePhoneDigitsForTts('Confirming 94455 81787', 'english')).toBe(
      'Confirming 9, 4, 4, 5, 5, 8, 1, 7, 8, 7'
    );
    expect(normalizePhoneDigitsForTts('உங்க நம்பர் 94455 81787', 'tamil')).toContain(
      'நைன், ஃபோர், ஃபோர், ஃபைவ், ஃபைவ், எய்ட், ஒன், செவன், எய்ட், செவன்'
    );

    // Tamil loanword consistency ("slot", "booking" keep consistent Tamil accent)
    const tamilSpoken = toPhoneticTamilForTts('நாளைக்கு 11:00 AM slot booking பண்ணலாமா?');
    expect(tamilSpoken).toContain('ஸ்லாட்');
    expect(tamilSpoken).toContain('புக்கிங்');
    expect(tamilSpoken).toContain('லெவன் ஏ எம்');

    // English language detection switches TTS target to en-IN without Tamil mangling
    expect(isCallerEnglish('Do you do video editing also?')).toBe(true);
    expect(isCallerEnglish('Meta ads-ku evlo aagum?')).toBe(false);
    const engPrepared = prepareTextForNaturalTts(
      'Yes, we do video and reels editing. Would you like to book a discovery call at 10:30 AM?'
    );
    expect(engPrepared.targetLanguageCode).toBe('en-IN');
    expect(engPrepared.spokenText).toContain('ten thirty AM');
    expect(engPrepared.spokenText).not.toMatch(/[\u0B80-\u0BFF]/);
  });

  it('handles 10-second silence deterministically with polite check-in and callback offer', async () => {
    const cfg = loadBusinessYamlConfig()!;
    const res = await generateNilaReplyWithSarvamLlm(SILENCE_10S_MARKER, undefined, 'outbound_sales', {
      businessYamlConfig: cfg,
    });
    expect(res.succeeded).toBe(true);
    expect(res.replyText).toContain('ஹலோ, கேக்குதா?');
    expect(res.replyText.toLowerCase()).toContain('callback');
  });

  it('immediately clears outbound playback over WebSocket when caller barge_in occurs', () => {
    const secret = 'test-barge-in-secret';
    const { server } = createNilaVoiceHttpServer({ callbackSigningSecret: secret });
    const attemptId = 'attempt-barge-in-1';
    const token = computeAttemptCallbackToken(attemptId, secret);

    const authSocket = new PassThrough();
    const outputChunks: Buffer[] = [];
    const origWrite = authSocket.write.bind(authSocket);
    authSocket.write = ((chunk: Buffer | string) => {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return origWrite(chunk);
    }) as typeof authSocket.write;

    const authReq = {
      url: `/exotel/media?attemptId=${attemptId}&token=${token}`,
      headers: {
        host: 'nila-voice.a.run.app',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      },
    } as unknown as IncomingMessage;

    server.emit('upgrade', authReq, authSocket, Buffer.alloc(0));
    authSocket.emit(
      'data',
      encodeMaskedClientTextFrame(
        JSON.stringify({ event: 'barge_in', stream_sid: 'stream-99' })
      )
    );

    const combined = Buffer.concat(outputChunks);
    const headerEnd = combined.indexOf('\r\n\r\n');
    expect(combined.subarray(0, headerEnd).toString('utf8')).toContain('101 Switching Protocols');

    const frame1Buf = combined.subarray(headerEnd + 4);
    const frame1 = decodeWebSocketFrame(frame1Buf);
    expect(frame1).not.toBeNull();
    const frame2Buf = frame1Buf.subarray(2 + frame1!.payload.length);
    const frame2 = decodeWebSocketFrame(frame2Buf);
    expect(frame2).not.toBeNull();

    const clearEvent = JSON.parse(frame2!.payload.toString('utf8')) as Record<string, unknown>;
    expect(clearEvent.event).toBe('clear');
    expect(clearEvent.reason).toBe('caller_barge_in');
    expect(clearEvent.attemptId).toBe(attemptId);
  });
});
