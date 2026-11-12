import fs from 'node:fs';
import path from 'node:path';
import {
  generateNilaReplyWithSarvamLlm,
  runFullNilaVoicePipeline,
  synthesizeNilaAudioWithBulbul,
  transcribeWithSarvamSaaras,
} from '../src/lib/voice/sarvam-nila';

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

async function main() {
  loadEnvLocal();

  console.log('=== Stage 3 (Standalone Pre-Synth): Synthesizing test Kongu Tanglish utterance with Bulbul v3 (ta-IN, ishita) ===');
  const seedUtterance =
    'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads campaign பத்தி பேச founder callback arrange பண்ண முடியுமாங்க?';
  const stage3Standalone = await synthesizeNilaAudioWithBulbul(seedUtterance);
  const wavBuf = stage3Standalone.succeeded
    ? Buffer.from(stage3Standalone.audioBase64, 'base64')
    : Buffer.alloc(0);

  console.log(
    JSON.stringify(
      {
        stage: '3_tts_standalone',
        succeeded: stage3Standalone.succeeded,
        requestedModel: stage3Standalone.requestedModel,
        modelUsed: stage3Standalone.modelUsed,
        speaker: stage3Standalone.speaker,
        languageCode: stage3Standalone.languageCode,
        wavBytes: wavBuf.length,
        validRiffHeader: wavBuf.subarray(0, 4).toString('ascii') === 'RIFF',
        latencyMs: stage3Standalone.latencyMs,
        error: stage3Standalone.error,
      },
      null,
      2
    )
  );

  console.log('\n=== Stage 1 (Standalone): Transcribing utterance with Sarvam Saaras v4 in codemix mode ===');
  const stage1Standalone = await transcribeWithSarvamSaaras(wavBuf, 'seed-utterance.wav', 'audio/wav');
  console.log(JSON.stringify(stage1Standalone, null, 2));

  console.log('\n=== Stage 2 (Standalone): Sending transcript to sarvam-105b-conversations via POST https://api.sarvam.ai/v1/chat/completions ===');
  const stage2Standalone = await generateNilaReplyWithSarvamLlm(
    stage1Standalone.transcript || seedUtterance
  );
  console.log(JSON.stringify(stage2Standalone, null, 2));

  console.log('\n=== All 3 Stages Together (Full Nila Voice Test Pipeline) ===');
  const combined = await runFullNilaVoicePipeline(wavBuf, 'utterance.wav', 'audio/wav');
  const replyWav = combined.tts.succeeded ? Buffer.from(combined.tts.audioBase64, 'base64') : Buffer.alloc(0);
  console.log(
    JSON.stringify(
      {
        allSucceeded: combined.allSucceeded,
        exotelDialingDisabled: combined.exotelDialingDisabled,
        googleSheetsWriteBackDisabled: combined.googleSheetsWriteBackDisabled,
        crmTasksCreated: combined.crmTasksCreated,
        transcription: combined.transcription,
        dialogue: combined.dialogue,
        tts: {
          ...combined.tts,
          audioBase64: `[base64 audio: ${combined.tts.audioBase64.length} chars, ${replyWav.length} bytes, RIFF=${replyWav.subarray(0, 4).toString('ascii') === 'RIFF'}]`,
        },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

