import { describe, expect, it, vi } from 'vitest';
import { getRuntimeEnv } from '@/lib/env';
import {
  createDiagnosticWavBuffer,
  NILA_KONGU_TANGLISH_SYSTEM_PROMPT,
  runFullNilaVoicePipeline,
} from '@/lib/voice/sarvam-nila';

describe('Nila Voice Test · Sarvam Saaras v4 + sarvam-105b-conversations + Bulbul v3 (ishita)', () => {
  it('loads the expected Sarvam STT, LLM, and TTS environment defaults', () => {
    const env = getRuntimeEnv();
    expect(env.sarvamSttModel).toBe('saaras:v4');
    expect(env.sarvamSttMode).toBe('codemix');
    expect(env.sarvamTtsModel).toBe('bulbul:v3');
    expect(env.sarvamTtsSpeaker).toBe('ritu');
    expect(env.sarvamTtsLanguage).toBe('ta-IN');
    expect(env.llmProvider).toBe('sarvam');
    expect(env.llmModel).toBe('sarvam-105b-conversations');
    expect(env.llmBaseUrl).toBe('https://api.sarvam.ai/v1');
  });

  it('enforces Kongu Tanglish rules, 1-2 sentence brevity, callback time confirmation, and zero CRM side effects', async () => {
    expect(NILA_KONGU_TANGLISH_SYSTEM_PROMPT).toContain('Tamilselvan Marimuthu');
    expect(NILA_KONGU_TANGLISH_SYSTEM_PROMPT).toContain('Tanglish');
    expect(NILA_KONGU_TANGLISH_SYSTEM_PROMPT).toContain('1 or 2 short sentences');
    expect(NILA_KONGU_TANGLISH_SYSTEM_PROMPT).toContain('confirmation');

    const wav = createDiagnosticWavBuffer(600, 16000);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');

    const prevKey = process.env.SARVAM_API_KEY;
    process.env.SARVAM_API_KEY = 'sk_test_server_only_key';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/speech-to-text')) {
        return new Response(
          JSON.stringify({
            transcript:
              'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads campaign பத்தி பேச founder callback arrange பண்ண முடியுமாங்க?',
            language_code: 'ta-IN',
          }),
          { status: 200 }
        );
      }
      if (url.includes('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            model: 'sarvam-105b-conversations',
            choices: [
              {
                message: {
                  content:
                    'கண்டிப்பா பண்ணிக்கலாங்க! நாளைக்கு காலைல 11 AM-க்கு நம்ம founder callback confirm பண்ணிக்கலாமாங்க?',
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/text-to-speech')) {
        return new Response(
          JSON.stringify({
            audios: [wav.toString('base64')],
          }),
          { status: 200 }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    try {
      const result = await runFullNilaVoicePipeline(wav, 'utterance.wav', 'audio/wav');
      expect(result.allSucceeded).toBe(true);
      expect(result.exotelDialingDisabled).toBe(true);
      expect(result.googleSheetsWriteBackDisabled).toBe(true);
      expect(result.crmTasksCreated).toBe(0);
      expect(result.transcription.modelUsed).toBe('saaras:v4');
      expect(result.transcription.modeUsed).toBe('codemix');
      expect(result.dialogue.modelUsed).toBe('sarvam-105b-conversations');
      expect(result.dialogue.replyText).toContain('11 AM');
      expect(result.tts.modelUsed).toBe('bulbul:v3');
      expect(result.tts.speaker).toBe('ritu');
      expect(result.tts.languageCode).toBe('ta-IN');
    } finally {
      fetchSpy.mockRestore();
      process.env.SARVAM_API_KEY = prevKey;
    }
  });
});

