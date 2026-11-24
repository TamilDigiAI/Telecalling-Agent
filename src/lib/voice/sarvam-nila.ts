import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeEnv, getServerSarvamApiKey } from '@/lib/env';
import {
  buildSharedNilaSystemPrompt,
  DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  type BusinessKnowledgeSettings,
} from '@/lib/knowledge/business-settings';
import {
  buildBusinessYamlSystemPrompt,
  isCallerEnglish,
  isSilenceInput,
  type BusinessYamlConfig,
} from '@/lib/knowledge/business-yaml';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DialogueGenerationOptions {
  history?: ConversationMessage[];
  businessYamlConfig?: BusinessYamlConfig | null;
  modelOverride?: string;
  maxTokens?: number;
}

export interface TtsSynthesisOptions {
  modelOverride?: string;
  speakerOverride?: string;
  languageOverride?: string;
  pace?: number;
}

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
 * Stage 2: Send transcript to Sarvam LLM using POST https://api.sarvam.ai/v1/chat/completions
 * Supports optional config/business.yaml grounding, multi-turn history, silence handling, and model benchmarking.
 */
export async function generateNilaReplyWithSarvamLlm(
  userTranscript: string,
  settings: BusinessKnowledgeSettings = DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  mode: 'outbound_sales' | 'founder_assistant' = 'outbound_sales',
  options?: DialogueGenerationOptions
): Promise<StageDialogueResult> {
  const start = Date.now();
  const env = getRuntimeEnv();
  const baseUrl = (env.llmBaseUrl || 'https://api.sarvam.ai/v1').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const requestedModel = options?.modelOverride?.trim() || env.llmModel || 'sarvam-105b-conversations';

  // Handle 10-second silence trigger deterministically when business.yaml is loaded
  if (options?.businessYamlConfig && isSilenceInput(userTranscript)) {
    return {
      stage: 'dialogue',
      succeeded: true,
      endpoint,
      modelUsed: 'silence-guard-10s',
      requestedModel,
      replyText: 'ஹலோ, கேக்குதா? இப்போ busy-ஆ இருந்தா, team callback arrange பண்ணட்டுமா?',
      latencyMs: Date.now() - start,
    };
  }

  const apiKey = getServerSarvamApiKey();
  const promptText =
    userTranscript.trim() ||
    'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads பத்தி பேச founder callback arrange பண்ண முடியுமா?';

  const systemPrompt = options?.businessYamlConfig
    ? buildBusinessYamlSystemPrompt(options.businessYamlConfig)
    : buildSharedNilaSystemPrompt(settings, mode);

  const candidateModels = options?.modelOverride
    ? [options.modelOverride.trim()]
    : Array.from(new Set([requestedModel, 'sarvam-105b', 'sarvam-m']));
  let lastError = '';

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...(options?.history ?? []),
    { role: 'user', content: promptText },
  ];

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
        messages,
        temperature: 0.25,
        max_tokens: options?.maxTokens ?? 160,
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

const HOUR_WORDS_EN: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
};

const HOUR_WORDS_TA_PHONETIC: Record<number, string> = {
  1: 'ஒன்',
  2: 'டூ',
  3: 'த்ரீ',
  4: 'ஃபோர்',
  5: 'ஃபைவ்',
  6: 'சிக்ஸ்',
  7: 'செவன்',
  8: 'எய்ட்',
  9: 'நைன்',
  10: 'டென்',
  11: 'லெவன்',
  12: 'ட்வெல்வ்',
};

const MINUTE_WORDS_EN: Record<number, string> = {
  0: '',
  15: 'fifteen',
  30: 'thirty',
  45: 'forty five',
};

const MINUTE_WORDS_TA_PHONETIC: Record<number, string> = {
  0: '',
  15: 'ஃபிஃப்டீன்',
  30: 'தர்ட்டி',
  45: 'ஃபார்ட்டி ஃபைவ்',
};

const DIGIT_WORDS_TA_PHONETIC: Record<string, string> = {
  '0': 'ஜீரோ',
  '1': 'ஒன்',
  '2': 'டூ',
  '3': 'த்ரீ',
  '4': 'ஃபோர்',
  '5': 'ஃபைவ்',
  '6': 'சிக்ஸ்',
  '7': 'செவன்',
  '8': 'எய்ட்',
  '9': 'நைன்',
};

/**
 * Converts clock times like "10:30 AM", "11:00 AM", "4:30 PM" into clear spoken phrasing
 * ("ten thirty AM" in English, "டென் தர்ட்டி ஏ எம்" in Tamil) so TTS never sounds robotic.
 */
export function normalizeSpokenTimesForTts(input: string, mode: 'tamil' | 'english'): string {
  return input.replace(
    /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(AM|PM)\b/gi,
    (_match, rawHour: string, rawMin: string | undefined, rawMeridiem: string) => {
      const hour = Number(rawHour);
      const min = rawMin ? Number(rawMin) : 0;
      const meridiem = rawMeridiem.toUpperCase();

      if (mode === 'english') {
        const hWord = HOUR_WORDS_EN[hour] || String(hour);
        const mWord =
          min === 0
            ? ''
            : MINUTE_WORDS_EN[min] || (min < 10 ? `oh ${min}` : String(min));
        return [hWord, mWord, meridiem].filter(Boolean).join(' ');
      }

      const hWord = HOUR_WORDS_TA_PHONETIC[hour] || String(hour);
      const mWord =
        min === 0
          ? ''
          : MINUTE_WORDS_TA_PHONETIC[min] || String(min);
      const merTa = meridiem === 'AM' ? 'ஏ எம்' : 'பி எம்';
      return [hWord, mWord, merTa].filter(Boolean).join(' ');
    }
  );
}

/**
 * Ensures 10-11 digit phone numbers (whether grouped like "94455 81787" or already spaced
 * "9 4 4 5 5 8 1 7 8 7") are read clearly digit-by-digit with brief natural pauses.
 */
export function normalizePhoneDigitsForTts(input: string, mode: 'tamil' | 'english'): string {
  return input.replace(/\b\d(?:[\s,-]*\d){9,10}\b/g, (segment) => {
    const digits = segment.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) return segment;
    if (mode === 'english') {
      return digits.split('').join(', ');
    }
    return digits
      .split('')
      .map((d) => DIGIT_WORDS_TA_PHONETIC[d] || d)
      .join(', ');
  });
}

const PHONETIC_TAMIL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bDigiAnchorZ\b/gi, 'டிஜி ஆங்கர்ஸ்'],
  [/\bTamilselvan\s+Marimuthu\b/gi, 'தமிழ்செல்வன் மாரிமுத்து'],
  [/\bTamilselvan\b/gi, 'தமிழ்செல்வன்'],
  [/\bKarthik\s+Subramanian\b/gi, 'கார்த்திக் சுப்ரமணியன்'],
  [/\bVinayaga\s+Complex\b/gi, 'விநாயகா காம்ப்ளெக்ஸ்'],
  [/\bThanthoni\b/gi, 'தாந்தோணி'],
  [/\bKarur\b/gi, 'கரூர்'],
  [/\bRoom\s+No\.?\s*4\b/gi, 'ரூம் நம்பர் நாலு'],
  [/\b2nd\s+Floor\b/gi, 'செகண்ட் ஃப்ளோர்'],
  [/\bGoogle\s+Business\s+Profile\b/gi, 'கூகுள் பிசினஸ் ப்ரொஃபைல்'],
  [/\bsocial\s+media\s+management\b/gi, 'சோஷியல் மீடியா மேனேஜ்மென்ட்'],
  [/\bdiscovery\s+call\b/gi, 'டிஸ்கவரி கால்'],
  [/\bcustom\s+quote\b/gi, 'கஸ்டம் கோட்'],
  [/\bAI\s+agents?\b/gi, 'ஏஐ ஏஜென்ட்ஸ்'],
  [/\bAI\s+assistant\b/gi, 'ஏஐ அசிஸ்டன்ட்'],
  [/\bPilot\s+Test\b/gi, 'பைலட் டெஸ்ட்'],
  [/\bMeta\s+Ads\b/gi, 'மெட்டா ஆட்ஸ்'],
  [/\bGoogle\s+Ads\b/gi, 'கூகுள் ஆட்ஸ்'],
  [/\bGoogle\b/gi, 'கூகுள்'],
  [/\bLocal\s+SEO\b/gi, 'லோக்கல் எஸ்இஓ'],
  [/\bSEO\b/gi, 'எஸ்இஓ'],
  [/\bFacebook\b/gi, 'ஃபேஸ்புக்'],
  [/\bInstagram\b/gi, 'இன்ஸ்டாகிராம்'],
  [/\bWhatsApp\b/gi, 'வாட்ஸ்அப்'],
  [/\bCRM\b/gi, 'சிஆர்எம்'],
  [/\bAI\b/g, 'ஏஐ'],
  [/\bMD\b/g, 'எம்.டி'],
  [/\bTDCC\b/gi, 'டிடிசிசி'],
  [/\bMSME\b/gi, 'எம்எஸ்எம்இ'],
  [/\bIST\b/g, ''],
  [/\bwrong\s+number\b/gi, 'ராங் நம்பர்'],
  [/\bslots\b/gi, 'ஸ்லாட்ஸ்'],
  [/\bslot\b/gi, 'ஸ்லாட்'],
  [/\bbooking\b/gi, 'புக்கிங்'],
  [/\bbooked\b/gi, 'புக்'],
  [/\bbook\b/gi, 'புக்'],
  [/\bdiscount\b/gi, 'டிஸ்கவுன்ட்'],
  [/\bguarantee\b/gi, 'கேரண்டி'],
  [/\bmanager\b/gi, 'மேனேஜர்'],
  [/\btransfer\b/gi, 'டிரான்ஸ்ஃபர்'],
  [/\bhospital\b/gi, 'ஹாஸ்பிடல்'],
  [/\branking\b/gi, 'ரேங்கிங்'],
  [/\boffice\b/gi, 'ஆஃபீஸ்'],
  [/\bvideo\s+content\b/gi, 'வீடியோ கன்டென்ட்'],
  [/\bvideo\/reels\b/gi, 'வீடியோ மற்றும் ரீல்ஸ்'],
  [/\bvideo\b/gi, 'வீடியோ'],
  [/\breels\b/gi, 'ரீல்ஸ்'],
  [/\benquiries\b/gi, 'என்குயரீஸ்'],
  [/\benquiry\b/gi, 'என்குயரி'],
  [/\bassistant\b/gi, 'அசிஸ்டன்ட்'],
  [/\bcallback\b/gi, 'கால்பேக்'],
  [/\bcall\b/gi, 'கால்'],
  [/\barrange\b/gi, 'அரேஞ்ச்'],
  [/\bconfirm\b/gi, 'கன்ஃபார்ம்'],
  [/\bbusiness\b/gi, 'பிசினஸ்'],
  [/\bcampaign\b/gi, 'கேம்பெய்ன்'],
  [/\bscope\b/gi, 'ஸ்கோப்'],
  [/\bad\s+budget\b/gi, 'ஆட் பட்ஜெட்'],
  [/\bbudget\s+range\b/gi, 'பட்ஜெட் ரேஞ்ச்'],
  [/\bbudget\b/gi, 'பட்ஜெட்'],
  [/\bmonthly\b/gi, 'மாதாந்திர'],
  [/\bquote\b/gi, 'கோட்'],
  [/\bteam\b/gi, 'டீம்'],
  [/\bsales\b/gi, 'சேல்ஸ்'],
  [/\blead\s+generation\b/gi, 'லீட் ஜெனரேஷன்'],
  [/\bleads\b/gi, 'லீட்ஸ்'],
  [/\blead\b/gi, 'லீட்'],
  [/\bwebsite\b/gi, 'வெப்சைட்'],
  [/\blanding\s+page\b/gi, 'லேண்டிங் பேஜ்'],
  [/\bautomation\b/gi, 'ஆட்டோமேஷன்'],
  [/\bworkflows\b/gi, 'ஒர்க்ஃப்ளோஸ்'],
  [/\bbranding\b/gi, 'பிராண்டிங்'],
  [/\bshort\b/gi, 'ஷார்ட்'],
  [/\bsir\b/gi, 'சார்'],
  [/\bstart\b/gi, 'ஸ்டார்ட்'],
  [/\bissue\b/gi, 'இஷ்யூ'],
  [/\btiming\b/gi, 'டைமிங்'],
  [/\btime\b/gi, 'டைம்'],
  [/\bfull\b/gi, 'ஃபுல்'],
  [/\bgoal\b/gi, 'கோல்'],
  [/\bfree\b/gi, 'ஃப்ரீ'],
  [/\bbusy\b/gi, 'பிஸி'],
  [/\bhelp\b/gi, 'ஹெல்ப்'],
  [/\bsorry\b/gi, 'சாரி'],
  [/\bok\b/gi, 'ஓகே'],
  [/\bnumber\b/gi, 'நம்பர்'],
  [/\bconvenient\b/gi, 'வசதியா'],
  [/\bfounder\b/gi, 'ஃபவுண்டர்'],
  [/\bdetails\b/gi, 'டீடெய்ல்ஸ்'],
  [/\bservices\b/gi, 'சர்வீசஸ்'],
  [/\bservice\b/gi, 'சர்வீஸ்'],
  [/\bchannel\b/gi, 'சேனல்'],
  [/\bemail\b/gi, 'ஈமெயில்'],
  [/\bfor\b/gi, ''],
  [/\band\b/gi, 'மற்றும்'],
];

/**
 * Converts English business terms, times, and phone numbers into smooth phonetic Tamil script
 * so Tamil TTS engines maintain one consistent, unbroken Tamil accent without robotic jumps.
 */
export function toPhoneticTamilForTts(input: string): string {
  let text = input.replace(/[()]/g, ' ');
  text = normalizeSpokenTimesForTts(text, 'tamil');
  text = normalizePhoneDigitsForTts(text, 'tamil');
  for (const [pattern, replacement] of PHONETIC_TAMIL_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Prepares reply text for TTS while automatically switching between natural Indian English
 * (when the reply is in English) and smooth phonetic Tamil (when Tamil/Tanglish).
 */
export function prepareTextForNaturalTts(
  replyText: string,
  defaultLanguageCode = 'ta-IN'
): { spokenText: string; targetLanguageCode: string } {
  const isPureEnglish = isCallerEnglish(replyText);
  if (isPureEnglish) {
    let spoken = replyText.replace(/[()]/g, ' ');
    spoken = normalizeSpokenTimesForTts(spoken, 'english');
    spoken = normalizePhoneDigitsForTts(spoken, 'english');
    return {
      spokenText: spoken.replace(/\s+/g, ' ').trim(),
      targetLanguageCode: 'en-IN',
    };
  }

  return {
    spokenText: toPhoneticTamilForTts(replyText),
    targetLanguageCode: defaultLanguageCode || 'ta-IN',
  };
}

let cachedElevenLabsVoiceId: string | null = null;

async function trySynthesizeWithElevenLabsReferenceVoice(
  phoneticText: string,
  startMs: number
): Promise<StageTtsResult | null> {
  const elevenKey = process.env.ELEVENLABS_API_KEY?.trim() || '';
  if (!elevenKey || elevenKey.includes('your_elevenlabs')) {
    return null;
  }

  let voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || cachedElevenLabsVoiceId || '';

  // If no voice ID is pre-configured, automatically clone the uploaded Karur reference audio
  if (!voiceId) {
    const refPath = path.resolve(process.cwd(), 'public/audio/nila-reference-voice.mp3');
    if (fs.existsSync(refPath)) {
      const form = new FormData();
      const bytes = new Uint8Array(fs.readFileSync(refPath));
      form.append('name', 'Nila - DigiAnchorZ Karur Reference');
      form.append(
        'description',
        'Warm, clear Karur Tamil female voice cloned from WhatsApp reference audio'
      );
      form.append('files', new Blob([bytes], { type: 'audio/mpeg' }), 'nila-reference-voice.mp3');

      const cloneRes = await fetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey },
        body: form,
      });
      if (cloneRes.ok) {
        const cloneJson = (await cloneRes.json()) as { voice_id?: string };
        if (cloneJson.voice_id) {
          voiceId = cloneJson.voice_id;
          cachedElevenLabsVoiceId = voiceId;
        }
      }
    }
  }

  if (!voiceId) return null;

  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': elevenKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: phoneticText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.68,
          similarity_boost: 0.92,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!ttsRes.ok) return null;
  const arrayBuf = await ttsRes.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuf).toString('base64');

  return {
    stage: 'tts',
    succeeded: Boolean(audioBase64),
    modelUsed: 'eleven_multilingual_v2',
    requestedModel: 'eleven_multilingual_v2',
    speaker: `karur-reference (${voiceId})`,
    languageCode: 'ta-IN',
    audioBase64,
    mimeType: 'audio/mpeg',
    latencyMs: Date.now() - startMs,
  };
}

/**
 * Stage 3: Generate reply audio using Sarvam Bulbul v3 with selected speaker "ritu".
 * - Keeps Tamil script for Tamil words and natural pronunciation for business terms.
 */
export async function synthesizeNilaAudioWithBulbul(
  replyText: string,
  options?: TtsSynthesisOptions
): Promise<StageTtsResult> {
  const start = Date.now();
  const env = getRuntimeEnv();
  const defaultLanguage = options?.languageOverride || env.sarvamTtsLanguage || 'ta-IN';
  const { spokenText, targetLanguageCode } = prepareTextForNaturalTts(
    replyText,
    defaultLanguage
  );

  const apiKey = getServerSarvamApiKey();
  const requestedModel = options?.modelOverride?.trim() || env.sarvamTtsModel || 'bulbul:v3';
  const speaker = (options?.speakerOverride?.trim() || env.sarvamTtsSpeaker || 'ritu').toLowerCase();
  const languageCode = options?.languageOverride?.trim() || targetLanguageCode;

  const response = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': apiKey,
    },
    body: JSON.stringify({
      text: spokenText,
      target_language_code: languageCode,
      speaker,
      model: requestedModel,
      pace: options?.pace ?? 0.96,
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
  settings: BusinessKnowledgeSettings = DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  dialogueOptions?: DialogueGenerationOptions
): Promise<FullNilaVoiceTestResult> {
  const transcription = await transcribeWithSarvamSaaras(audioBuffer, fileName, mimeType);

  const effectiveInput =
    transcription.transcript.trim() ||
    'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads பத்தி பேச founder callback arrange பண்ண முடியுமா?';

  const dialogue = await generateNilaReplyWithSarvamLlm(
    effectiveInput,
    settings,
    'outbound_sales',
    dialogueOptions
  );

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

