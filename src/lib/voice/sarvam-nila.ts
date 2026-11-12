import { getRuntimeEnv, getServerSarvamApiKey } from '@/lib/env';
import {
  buildSharedNilaSystemPrompt,
  DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  type BusinessKnowledgeSettings,
} from '@/lib/knowledge/business-settings';

export const NILA_KONGU_TANGLISH_SYSTEM_PROMPT = buildSharedNilaSystemPrompt(
  DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  'outbound_sales'
);

export interface StageTranscriptionResult {
  stage: 'transcription';
  succeeded: boolean;
  modelUsed: string;
  requestedModel: string;
  modeUsed: string;
  languageCode: string;
  transcript: string;
  latencyMs: number;
  error?: string;
}

export interface StageDialogueResult {
  stage: 'dialogue';
  succeeded: boolean;
  endpoint: string;
  modelUsed: string;
  requestedModel: string;
  replyText: string;
  latencyMs: number;
  error?: string;
}

export interface StageTtsResult {
  stage: 'tts';
  succeeded: boolean;
  modelUsed: string;
  requestedModel: string;
  speaker: string;
  languageCode: string;
  audioBase64: string;
  mimeType: string;
  latencyMs: number;
  error?: string;
}

export interface FullNilaVoiceTestResult {
  exotelDialingDisabled: true;
  googleSheetsWriteBackDisabled: true;
  crmTasksCreated: 0;
  transcription: StageTranscriptionResult;
  dialogue: StageDialogueResult;
  tts: StageTtsResult;
  allSucceeded: boolean;
}

/**
 * Generates a valid 16kHz 16-bit mono PCM WAV buffer containing a spoken-cadence tone burst
 * for automated diagnostics when no microphone file is uploaded.
 */
export function createDiagnosticWavBuffer(durationMs = 1200, sampleRate = 16000): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format = 1
  buffer.writeUInt16LE(1, 22); // Mono = 1 channel
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.sin((Math.PI * i) / numSamples);
    const sample = Math.floor(envelope * 6000 * Math.sin(2 * Math.PI * 220 * t));
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  return buffer;
}

/**
 * Stage 1: Transcribe short utterance with Sarvam Saaras v4 in codemix mode.
 */
export async function transcribeWithSarvamSaaras(
  audioBuffer: Buffer,
  fileName = 'utterance.wav',
  mimeType = 'audio/wav'
): Promise<StageTranscriptionResult> {
  const start = Date.now();
  const env = getRuntimeEnv();
  const apiKey = getServerSarvamApiKey();
  const requestedModel = env.sarvamSttModel || 'saaras:v4';
  const mode = env.sarvamSttMode || 'codemix';
  const languageCode = env.sarvamTtsLanguage || 'ta-IN';

  const candidateModels = Array.from(new Set([requestedModel, 'saaras:v3', 'saaras:v2.5']));
  let lastError = '';

  for (const modelCandidate of candidateModels) {
    const form = new FormData();
    const uint8 = new Uint8Array(audioBuffer);
    const blob = new Blob([uint8], { type: mimeType || 'audio/wav' });
    form.append('file', blob, fileName);
    form.append('model', modelCandidate);
    form.append('mode', mode);
    form.append('language_code', languageCode);

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
      },
      body: form,
    });

    if (response.ok) {
      const data = (await response.json()) as {
        transcript?: string;
        language_code?: string;
      };
      return {
        stage: 'transcription',
        succeeded: true,
        modelUsed: modelCandidate,
        requestedModel,
        modeUsed: mode,
        languageCode: data.language_code || languageCode,
        transcript: (data.transcript ?? '').trim(),
        latencyMs: Date.now() - start,
      };
    }

    const errText = await response.text();
    lastError = `HTTP ${response.status} (${modelCandidate}): ${errText}`;
    // Only fall back if the error specifically indicates model name enum rejection
    if (!errText.toLowerCase().includes('model') && response.status !== 400 && response.status !== 422) {
      break;
    }
  }

  return {
    stage: 'transcription',
    succeeded: false,
    modelUsed: requestedModel,
    requestedModel,
    modeUsed: mode,
    languageCode,
    transcript: '',
    latencyMs: Date.now() - start,
    error: lastError,
  };
}

/**
 * Clean out any <think>...</think> reasoning tags if returned by a reasoning-capable Sarvam model.
 */
function stripReasoningTags(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Stage 2: Send transcript to sarvam-105b-conversations using POST https://api.sarvam.ai/v1/chat/completions
 */
export async function generateNilaReplyWithSarvamLlm(
  userTranscript: string,
  settings: BusinessKnowledgeSettings = DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  mode: 'outbound_sales' | 'founder_assistant' = 'outbound_sales'
): Promise<StageDialogueResult> {
  const start = Date.now();
  const env = getRuntimeEnv();
  const apiKey = getServerSarvamApiKey();
  const baseUrl = (env.llmBaseUrl || 'https://api.sarvam.ai/v1').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const requestedModel = env.llmModel || 'sarvam-105b-conversations';

  const promptText =
    userTranscript.trim() ||
    'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads பத்தி பேச founder callback arrange பண்ண முடியுமா?';

  const systemPrompt = buildSharedNilaSystemPrompt(settings, mode);
  const candidateModels = Array.from(
    new Set([requestedModel, 'sarvam-105b', 'sarvam-m'])
  );
  let lastError = '';

  for (const modelCandidate of candidateModels) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelCandidate,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: promptText,
          },
        ],
        temperature: 0.4,
        max_tokens: 180,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        model?: string;
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };
      const rawReply = data.choices?.[0]?.message?.content ?? '';
      const replyText = stripReasoningTags(rawReply);

      if (replyText) {
        return {
          stage: 'dialogue',
          succeeded: true,
          endpoint,
          modelUsed: data.model || modelCandidate,
          requestedModel,
          replyText,
          latencyMs: Date.now() - start,
        };
      }
    }

    const errText = await response.text();
    lastError = `HTTP ${response.status} (${modelCandidate}): ${errText}`;
    if (!errText.toLowerCase().includes('model') && response.status !== 400 && response.status !== 404 && response.status !== 422) {
      break;
    }
  }

  return {
    stage: 'dialogue',
    succeeded: false,
    endpoint,
    modelUsed: requestedModel,
    requestedModel,
    replyText: '',
    latencyMs: Date.now() - start,
    error: lastError,
  };
}

/**
 * Stage 3: Generate reply audio with Bulbul v3, language ta-IN, speaker ishita.
 */
export async function synthesizeNilaAudioWithBulbul(
  replyText: string
): Promise<StageTtsResult> {
  const start = Date.now();
  const env = getRuntimeEnv();
  const apiKey = getServerSarvamApiKey();
  const requestedModel = env.sarvamTtsModel || 'bulbul:v3';
  const speaker = env.sarvamTtsSpeaker || 'ishita';
  const languageCode = env.sarvamTtsLanguage || 'ta-IN';

  const response = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': apiKey,
    },
    body: JSON.stringify({
      text: replyText,
      target_language_code: languageCode,
      speaker,
      model: requestedModel,
      pace: 1.0,
      speech_sample_rate: 24000,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return {
      stage: 'tts',
      succeeded: false,
      modelUsed: requestedModel,
      requestedModel,
      speaker,
      languageCode,
      audioBase64: '',
      mimeType: 'audio/wav',
      latencyMs: Date.now() - start,
      error: `HTTP ${response.status}: ${errText}`,
    };
  }

  const data = (await response.json()) as {
    audios?: string[];
  };
  const audioBase64 = data.audios?.[0] ?? '';

  return {
    stage: 'tts',
    succeeded: Boolean(audioBase64),
    modelUsed: requestedModel,
    requestedModel,
    speaker,
    languageCode,
    audioBase64,
    mimeType: 'audio/wav',
    latencyMs: Date.now() - start,
    error: audioBase64 ? undefined : 'No audio payload returned from Sarvam Bulbul v3',
  };
}

/**
 * Full 3-Stage Nila Voice Test Pipeline (STT -> LLM -> TTS).
 * Keeps Exotel dialing and Google Sheets write-back disabled and creates 0 CRM tasks.
 */
export async function runFullNilaVoicePipeline(
  audioBuffer: Buffer,
  fileName = 'utterance.wav',
  mimeType = 'audio/wav',
  settings: BusinessKnowledgeSettings = DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS
): Promise<FullNilaVoiceTestResult> {
  const transcription = await transcribeWithSarvamSaaras(audioBuffer, fileName, mimeType);

  const effectiveInput =
    transcription.transcript.trim() ||
    'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads பத்தி பேச founder callback arrange பண்ண முடியுமா?';

  const dialogue = await generateNilaReplyWithSarvamLlm(effectiveInput, settings, 'outbound_sales');

  const tts = dialogue.succeeded
    ? await synthesizeNilaAudioWithBulbul(dialogue.replyText)
    : {
        stage: 'tts' as const,
        succeeded: false,
        modelUsed: getRuntimeEnv().sarvamTtsModel,
        requestedModel: getRuntimeEnv().sarvamTtsModel,
        speaker: getRuntimeEnv().sarvamTtsSpeaker,
        languageCode: getRuntimeEnv().sarvamTtsLanguage,
        audioBase64: '',
        mimeType: 'audio/wav',
        latencyMs: 0,
        error: 'Skipped TTS because dialogue stage failed.',
      };

  return {
    exotelDialingDisabled: true,
    googleSheetsWriteBackDisabled: true,
    crmTasksCreated: 0,
    transcription,
    dialogue,
    tts,
    allSucceeded: Boolean(transcription.succeeded && dialogue.succeeded && tts.succeeded),
  };
}

