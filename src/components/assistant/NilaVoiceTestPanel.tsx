'use client';

import React, { useRef, useState } from 'react';
import type {
  FullNilaVoiceTestResult,
  StageDialogueResult,
  StageTranscriptionResult,
  StageTtsResult,
} from '@/lib/voice/sarvam-nila';

function encodeWavFromFloat32(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function NilaVoiceTestPanel({
  sttModel,
  sttMode,
  ttsModel,
  ttsSpeaker,
  ttsLanguage,
  llmModel,
}: {
  sttModel: string;
  sttMode: string;
  ttsModel: string;
  ttsSpeaker: string;
  ttsLanguage: string;
  llmModel: string;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [transcription, setTranscription] = useState<StageTranscriptionResult | null>(null);
  const [dialogue, setDialogue] = useState<StageDialogueResult | null>(null);
  const [tts, setTts] = useState<StageTtsResult | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<'idle' | 'playing' | 'succeeded' | 'blocked' | 'interrupted'>('idle');
  const [bargeInCount, setBargeInCount] = useState(0);

  const [sampleUtteranceText, setSampleUtteranceText] = useState(
    'Hello, digital marketing pathi details venum.'
  );

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  function interruptAgentPlayback(): boolean {
    let interrupted = false;
    if (audioElementRef.current && !audioElementRef.current.paused) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
      setPlaybackStatus('interrupted');
      interrupted = true;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      interrupted = true;
    }
    if (interrupted) {
      setBargeInCount((c) => c + 1);
    }
    return interrupted;
  }

  async function playBase64Audio(base64Audio: string, mimeType = 'audio/wav') {
    if (!base64Audio) return;
    const dataUrl = `data:${mimeType};base64,${base64Audio}`;
    if (audioElementRef.current) {
      audioElementRef.current.src = dataUrl;
      try {
        setPlaybackStatus('playing');
        await audioElementRef.current.play();
      } catch {
        setPlaybackStatus('blocked');
      }
    }
  }

  async function startPushToTalk() {
    // Immediate barge-in: stop Nila mid-sentence if caller starts speaking
    interruptAgentPlayback();
    setErrorMessage(null);
    pcmChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(input));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      setIsRecording(true);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Microphone error: ${err.message}`
          : 'Could not access microphone for push-to-talk.'
      );
    }
  }

  async function stopPushToTalkAndSend() {
    if (!isRecording) return;
    setIsRecording(false);

    const sampleRate = audioContextRef.current?.sampleRate || 16000;
    processorRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    await audioContextRef.current?.close().catch(() => undefined);

    const totalLength = pcmChunksRef.current.reduce((acc, cur) => acc + cur.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of pcmChunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    if (merged.length < sampleRate * 0.25) {
      setErrorMessage('Recording too short. Hold the Push-to-Talk button while speaking a short utterance.');
      return;
    }

    const wavBlob = encodeWavFromFloat32(merged, sampleRate);
    await sendAudioBlobToPipeline(wavBlob);
  }

  async function sendAudioBlobToPipeline(wavBlob: Blob) {
    setIsLoading(true);
    setActiveAction('push_to_talk');
    setErrorMessage(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const form = new FormData();
      form.append('stage', 'full');
      form.append('audio', wavBlob, 'utterance.wav');

      const res = await fetch('/api/assistant/nila-voice-test', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const data = (await res.json()) as FullNilaVoiceTestResult & { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setTranscription(data.transcription);
      setDialogue(data.dialogue);
      setTts(data.tts);
      if (data.tts?.audioBase64) {
        await playBase64Audio(data.tts.audioBase64, data.tts.mimeType);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorMessage(err instanceof Error ? err.message : 'Voice test failed');
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsLoading(false);
      setActiveAction(null);
    }
  }

  async function runStageTest(stage: 'stt' | 'dialogue' | 'tts' | 'full' | 'silence') {
    interruptAgentPlayback();
    setIsLoading(true);
    setActiveAction(stage);
    setErrorMessage(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const res = await fetch('/api/assistant/nila-voice-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage,
          transcript: sampleUtteranceText,
          replyText: dialogue?.replyText,
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (data.transcription) setTranscription(data.transcription);
      if (data.dialogue) setDialogue(data.dialogue);
      if (data.tts) {
        setTts(data.tts);
        if (data.tts.audioBase64) {
          await playBase64Audio(data.tts.audioBase64, data.tts.mimeType);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorMessage(err instanceof Error ? err.message : 'Stage test failed');
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsLoading(false);
      setActiveAction(null);
    }
  }

  return (
    <section
      aria-label="Nila Voice Test"
      className="bg-white border-2 border-[#149642] rounded-2xl p-6 space-y-5 shadow-sm"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-[#E2E8E2] pb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold text-[#0B1220]">
              Nila Voice Test · Private Browser Sandbox
            </h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#149642]/15 text-[#0F7633]">
              Kongu Tanglish Persona
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1">
            STT: <code className="font-mono">{sttModel}</code> (<code className="font-mono">{sttMode}</code>) ·
            LLM: <code className="font-mono">{llmModel}</code> · TTS:{' '}
            <code className="font-mono">{ttsModel}</code> (<code className="font-mono">{ttsSpeaker}</code>,{' '}
            <code className="font-mono">{ttsLanguage}</code>)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
          <span className="px-2.5 py-1 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] text-slate-700">
            Vobiz Outbound Dialing: DISABLED
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] text-slate-700">
            Google Sheets Write-Back: DISABLED
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-[#FBB61B]/25 border border-[#FBB61B] text-[#0B1220]">
            CRM Tasks Created: 0
          </span>
        </div>
      </div>

      {/* Push-to-Talk & Stage Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
        <div className="lg:col-span-5 flex flex-col items-center justify-center p-5 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] text-center space-y-3">
          <button
            type="button"
            onMouseDown={startPushToTalk}
            onMouseUp={stopPushToTalkAndSend}
            onTouchStart={startPushToTalk}
            onTouchEnd={stopPushToTalkAndSend}
            onClick={() => {
              if (isRecording) {
                void stopPushToTalkAndSend();
              }
            }}
            className={`w-full py-4 px-5 rounded-xl font-bold text-sm transition-all cursor-pointer select-none ${
              isRecording
                ? 'bg-red-600 text-white ring-4 ring-red-200 animate-pulse'
                : 'bg-[#0F7633] hover:bg-[#149642] text-white shadow-sm'
            }`}
          >
            {isRecording
              ? 'Recording Utterance... Release to Send to Nila'
              : playbackStatus === 'playing'
                ? 'Hold to Interrupt Nila (Barge-In)'
                : isLoading && activeAction === 'push_to_talk'
                  ? 'Processing Utterance on Server...'
                  : 'Hold to Speak (Push-to-Talk)'}
          </button>
          <p className="text-xs text-slate-600">
            Hold the button anytime to interrupt Nila mid-sentence (barge-in) and record your reply.
            {bargeInCount > 0 ? ` · Barge-ins: ${bargeInCount}` : ''}
          </p>
        </div>

        <div className="lg:col-span-7 space-y-3">
          <div>
            <label
              htmlFor="sampleUtteranceText"
              className="block text-xs font-semibold uppercase text-slate-700 mb-1"
            >
              Test Utterance / Stage Diagnostic Input
            </label>
            <input
              id="sampleUtteranceText"
              type="text"
              value={sampleUtteranceText}
              onChange={(e) => setSampleUtteranceText(e.target.value)}
              className="w-full rounded-lg border border-[#E2E8E2] px-3 py-2 text-xs text-[#0B1220]"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => runStageTest('stt')}
              className="px-3 py-2 rounded-lg border border-[#E2E8E2] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B1220] cursor-pointer"
            >
              1. Test STT ({sttModel})
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => runStageTest('dialogue')}
              className="px-3 py-2 rounded-lg border border-[#E2E8E2] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B1220] cursor-pointer"
            >
              2. Test Dialogue ({llmModel})
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => runStageTest('tts')}
              className="px-3 py-2 rounded-lg border border-[#E2E8E2] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B1220] cursor-pointer"
            >
              3. Test TTS ({ttsModel} · {ttsSpeaker})
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => runStageTest('full')}
              className="px-3.5 py-2 rounded-lg bg-[#FBB61B] hover:bg-[#f0aa0c] text-xs font-bold text-[#0B1220] cursor-pointer"
            >
              Run All 3 Stages Together
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={() => runStageTest('silence')}
              className="px-3 py-2 rounded-lg border border-[#E2E8E2] bg-white hover:bg-slate-50 text-xs font-semibold text-[#0B1220] cursor-pointer"
            >
              Test 10s Silence
            </button>
          </div>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900"
        >
          <strong>Voice Test Error:</strong> {errorMessage}
        </div>
      )}

      {/* Transcript & Reply Display */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase text-slate-700">
              1. Caller Transcript (Saaras Codemix)
            </span>
            {transcription && (
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                  transcription.succeeded
                    ? 'bg-emerald-100 text-emerald-900'
                    : 'bg-red-100 text-red-900'
                }`}
              >
                {transcription.succeeded
                  ? `PASS · ${transcription.modelUsed} (${transcription.latencyMs}ms)`
                  : 'FAILED'}
              </span>
            )}
          </div>
          <p className="text-sm text-[#0B1220] min-h-[44px]">
            {transcription?.transcript || (
              <span className="text-slate-400 italic">
                Record or run a test to view the caller transcript...
              </span>
            )}
          </p>
          {transcription?.error && (
            <p className="text-xs text-red-700 font-mono">{transcription.error}</p>
          )}
        </div>

        <div className="p-4 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase text-[#0F7633]">
              2. Nila&apos;s Reply (Kongu Tanglish · 1–2 Sentences)
            </span>
            {dialogue && (
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                  dialogue.succeeded
                    ? 'bg-emerald-100 text-emerald-900'
                    : 'bg-red-100 text-red-900'
                }`}
              >
                {dialogue.succeeded
                  ? `PASS · ${dialogue.modelUsed} (${dialogue.latencyMs}ms)`
                  : 'FAILED'}
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-[#0B1220] min-h-[44px]">
            {dialogue?.replyText || (
              <span className="text-slate-400 italic">
                Nila&apos;s Kongu Tanglish response will appear here...
              </span>
            )}
          </p>
          {dialogue?.error && <p className="text-xs text-red-700 font-mono">{dialogue.error}</p>}
        </div>
      </div>

      {/* Audio Playback Stage */}
      <div className="p-4 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase text-slate-700">
                3. Voice preview (Sarvam Bulbul v3 · {tts?.speaker || ttsSpeaker})
              </span>
              {tts && (
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                    tts.succeeded ? 'bg-emerald-100 text-emerald-900' : 'bg-red-100 text-red-900'
                  }`}
                >
                  {tts.succeeded ? `PASS · ${tts.modelUsed} (${tts.latencyMs}ms)` : 'FAILED'}
                </span>
              )}
              {playbackStatus === 'interrupted' && (
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-900">
                  Barge-In Stopped
                </span>
              )}
              {playbackStatus === 'succeeded' && (
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#149642]/15 text-[#0F7633]">
                  Audio Played
                </span>
              )}
            </div>
            {tts?.error && <p className="text-xs text-red-700 font-mono">{tts.error}</p>}
          </div>

          <audio
            ref={audioElementRef}
            controls
            className="h-9 w-full sm:w-80"
            onPlay={() => setPlaybackStatus('playing')}
            onEnded={() => setPlaybackStatus('succeeded')}
          />
        </div>

        <div className="pt-3 border-t border-[#E2E8E2] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-slate-600">
            <strong className="text-[#0B1220]">Reference Voice Profile Loaded:</strong> Uploaded Karur
            Tamil Reference Audio (<code className="font-mono">/audio/nila-reference-voice.mp3</code>)
          </div>
          <audio
            src="/audio/nila-reference-voice.mp3"
            controls
            className="h-8 w-full sm:w-80"
          />
        </div>
      </div>
    </section>
  );
}

