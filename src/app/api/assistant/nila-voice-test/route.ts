import { NextResponse, type NextRequest } from 'next/server';
import { requireWorkspaceActionContext, WorkspaceAccessDeniedError } from '@/lib/auth/workspace-guard';
import { resolveBusinessKnowledgeSettings } from '@/lib/knowledge/business-settings';
import { loadBusinessYamlConfig, SILENCE_10S_MARKER } from '@/lib/knowledge/business-yaml';
import {
  createDiagnosticWavBuffer,
  generateNilaReplyWithSarvamLlm,
  runFullNilaVoicePipeline,
  synthesizeNilaAudioWithBulbul,
  transcribeWithSarvamSaaras,
  type ConversationMessage,
} from '@/lib/voice/sarvam-nila';

export const runtime = 'nodejs';

const SAMPLE_KONGU_UTTERANCE =
  'வணக்கம் நிலா, நாளைக்கு காலைல 11 AM-க்கு Meta Ads campaign பத்தி பேச founder callback arrange பண்ண முடியுமாங்க?';

/**
 * Protected Server-Side Route: POST /api/assistant/nila-voice-test
 * - Keeps SARVAM_API_KEY strictly server-side
 * - Keeps Exotel dialing and Google Sheets write-back disabled
 * - Does NOT create any CRM tasks
 */
export async function POST(request: NextRequest) {
  try {
    const { workspace } = await requireWorkspaceActionContext();
    const businessSettings = resolveBusinessKnowledgeSettings(workspace.business_profile);
    const businessYamlConfig = loadBusinessYamlConfig();

    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const testStage = String(formData.get('stage') ?? 'full');
      const uploaded = formData.get('audio');
      const rawHistory = formData.get('history');
      let history: ConversationMessage[] = [];
      if (typeof rawHistory === 'string' && rawHistory.trim()) {
        try {
          const parsed = JSON.parse(rawHistory);
          if (Array.isArray(parsed)) history = parsed;
        } catch {
          history = [];
        }
      }

      let audioBuffer: Buffer;
      let fileName = 'utterance.wav';
      let mimeType = 'audio/wav';

      if (uploaded && typeof uploaded === 'object' && 'arrayBuffer' in uploaded) {
        const arrayBuf = await (uploaded as Blob).arrayBuffer();
        audioBuffer = Buffer.from(arrayBuf);
        fileName = (uploaded as File).name || 'utterance.webm';
        mimeType = (uploaded as Blob).type || 'audio/webm';
      } else {
        // Generate spoken Kongu Tanglish WAV via Bulbul v3 for automated / push-to-talk fallback
        const synthSample = await synthesizeNilaAudioWithBulbul(SAMPLE_KONGU_UTTERANCE);
        audioBuffer = synthSample.succeeded
          ? Buffer.from(synthSample.audioBase64, 'base64')
          : createDiagnosticWavBuffer();
      }

      if (testStage === 'stt') {
        const transcription = await transcribeWithSarvamSaaras(audioBuffer, fileName, mimeType);
        return NextResponse.json({
          exotelDialingDisabled: true,
          googleSheetsWriteBackDisabled: true,
          crmTasksCreated: 0,
          transcription,
        });
      }

      const fullResult = await runFullNilaVoicePipeline(
        audioBuffer,
        fileName,
        mimeType,
        businessSettings,
        { businessYamlConfig, history }
      );
      return NextResponse.json(fullResult);
    }

    const body = (await request.json()) as {
      stage?: 'stt' | 'dialogue' | 'tts' | 'full' | 'silence';
      transcript?: string;
      replyText?: string;
      history?: ConversationMessage[];
    };

    const stage = body.stage ?? 'full';
    const history = Array.isArray(body.history) ? body.history : [];

    if (stage === 'silence') {
      const dialogue = await generateNilaReplyWithSarvamLlm(
        SILENCE_10S_MARKER,
        businessSettings,
        'outbound_sales',
        { businessYamlConfig, history }
      );
      const tts = dialogue.succeeded
        ? await synthesizeNilaAudioWithBulbul(dialogue.replyText)
        : undefined;
      return NextResponse.json({
        exotelDialingDisabled: true,
        googleSheetsWriteBackDisabled: true,
        crmTasksCreated: 0,
        dialogue,
        tts,
      });
    }

    if (stage === 'stt') {
      const sampleTts = await synthesizeNilaAudioWithBulbul(
        body.transcript || SAMPLE_KONGU_UTTERANCE
      );
      const wavBuf = sampleTts.succeeded
        ? Buffer.from(sampleTts.audioBase64, 'base64')
        : createDiagnosticWavBuffer();
      const transcription = await transcribeWithSarvamSaaras(wavBuf, 'sample.wav', 'audio/wav');
      return NextResponse.json({
        exotelDialingDisabled: true,
        googleSheetsWriteBackDisabled: true,
        crmTasksCreated: 0,
        transcription,
      });
    }

    if (stage === 'dialogue') {
      const dialogue = await generateNilaReplyWithSarvamLlm(
        body.transcript || SAMPLE_KONGU_UTTERANCE,
        businessSettings,
        'outbound_sales',
        { businessYamlConfig, history }
      );
      return NextResponse.json({
        exotelDialingDisabled: true,
        googleSheetsWriteBackDisabled: true,
        crmTasksCreated: 0,
        dialogue,
      });
    }

    if (stage === 'tts') {
      const tts = await synthesizeNilaAudioWithBulbul(
        body.replyText ||
          'வணக்கம்ங்க! நாளைக்கு காலைல 11 AM-க்கு நம்ம founder callback arrange பண்ணிக்கலாங்க, அந்த time confirm பண்ணட்டுமாங்க?'
      );
      return NextResponse.json({
        exotelDialingDisabled: true,
        googleSheetsWriteBackDisabled: true,
        crmTasksCreated: 0,
        tts,
      });
    }

    // stage === 'full' via JSON
    const sampleTts = await synthesizeNilaAudioWithBulbul(
      body.transcript || SAMPLE_KONGU_UTTERANCE
    );
    const wavBuf = sampleTts.succeeded
      ? Buffer.from(sampleTts.audioBase64, 'base64')
      : createDiagnosticWavBuffer();
    const fullResult = await runFullNilaVoicePipeline(
      wavBuf,
      'sample.wav',
      'audio/wav',
      businessSettings,
      { businessYamlConfig, history }
    );
    return NextResponse.json(fullResult);
  } catch (err) {
    if (err instanceof WorkspaceAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected server error' },
      { status: 500 }
    );
  }
}

