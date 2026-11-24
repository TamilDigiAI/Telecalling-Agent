'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type CallUiState = 'Ready' | 'Dialing' | 'Ringing' | 'Connected' | 'Completed' | 'Failed';

function stateBadgeClass(state: CallUiState): string {
  switch (state) {
    case 'Connected':
    case 'Completed':
      return 'bg-emerald-100 text-emerald-900 border-emerald-300';
    case 'Dialing':
    case 'Ringing':
      return 'bg-amber-100 text-amber-900 border-amber-300';
    case 'Failed':
      return 'bg-red-100 text-red-900 border-red-300';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

export function LiveNilaCallButton({
  leadId,
  phoneE164,
  fullName,
  eligible = true,
  doNotCall = false,
}: {
  leadId: string;
  phoneE164: string;
  fullName: string;
  eligible?: boolean;
  doNotCall?: boolean;
}) {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inFlightRef = useRef(false);

  const [callState, setCallState] = useState<CallUiState>('Ready');
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [providerCallSid, setProviderCallSid] = useState<string | null>(null);
  const [providerVerified, setProviderVerified] = useState(false);
  const [callDetail, setCallDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewScript, setPreviewScript] = useState<string | null>(null);

  // Poll real provider status while call is Dialing / Ringing / Connected
  useEffect(() => {
    if (!attemptId || !['Dialing', 'Ringing', 'Connected'].includes(callState)) {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/voice/call-status?attemptId=${encodeURIComponent(attemptId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.callState) {
          setCallState(data.callState);
          setProviderVerified(Boolean(data.providerVerified));
          if (data.providerCallSid) setProviderCallSid(data.providerCallSid);
          if (data.error) setError(data.error);
          if (data.callState === 'Completed' || data.callState === 'Failed') {
            router.refresh();
          }
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [attemptId, callState, router]);

  async function handleCallWithNila() {
    if (inFlightRef.current || !eligible || doNotCall) return;
    inFlightRef.current = true;
    setError(null);
    setCallDetail(null);
    setProviderVerified(false);
    setCallState('Dialing');

    // Per-click idempotency key prevents double-click duplicate dials
    const idempotencyKey = `ui-call:${leadId}:${Date.now()}`;

    try {
      const res = await fetch('/api/voice/call-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId, mode: 'live', idempotencyKey }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setCallState('Failed');
        setProviderVerified(false);
        setError(data.error || `Vobiz call rejected (HTTP ${res.status})`);
        return;
      }

      setAttemptId(data.attemptId ?? null);
      setProviderCallSid(data.providerCallSid ?? null);
      setProviderVerified(Boolean(data.providerVerified));
      setCallState((data.callState as CallUiState) || 'Dialing');
      setCallDetail(
        `Vobiz call initiated (ID: ${data.providerCallSid}) from ${data.callerId || 'Vobiz'} to ${phoneE164}.`
      );
      router.refresh();
    } catch (err) {
      setCallState('Failed');
      setProviderVerified(false);
      setError(err instanceof Error ? err.message : 'Call request failed');
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleVoicePreview() {
    if (previewLoading) return;
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/voice/call-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId, mode: 'preview' }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Voice preview failed (HTTP ${res.status})`);
      }
      setPreviewScript(data.spokenScript ?? null);
      if (data.audioBase64 && audioRef.current) {
        const mime = data.mimeType || 'audio/wav';
        audioRef.current.src = `data:${mime};base64,${data.audioBase64}`;
        await audioRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice preview failed');
    } finally {
      setPreviewLoading(false);
    }
  }

  const isBusy = callState === 'Dialing' || callState === 'Ringing' || callState === 'Connected';
  const callDisabled = isBusy || !eligible || doNotCall;

  return (
    <div className="w-full space-y-2 pt-2 border-t border-[#E2E8E2]">
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={callDisabled}
          onClick={handleCallWithNila}
          className={`px-4 py-2 rounded-lg text-white text-xs font-bold shadow-sm ${
            callDisabled
              ? 'bg-slate-400 cursor-not-allowed'
              : 'bg-[#0F7633] hover:bg-[#149642] cursor-pointer'
          }`}
        >
          {callState === 'Dialing'
            ? `Dialing ${phoneE164}...`
            : `Call with Nila (${phoneE164})`}
        </button>

        <span
          className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${stateBadgeClass(
            callState
          )}`}
        >
          State: {callState}
          {providerVerified && providerCallSid ? ` · Vobiz ${providerCallSid.slice(0, 12)}` : ''}
        </span>

        <button
          type="button"
          disabled={previewLoading}
          onClick={handleVoicePreview}
          className="px-3 py-1.5 rounded-lg border border-[#E2E8E2] bg-[#F7F9F6] hover:bg-slate-100 text-[#0B1220] text-xs font-semibold cursor-pointer"
        >
          {previewLoading ? 'Generating Voice preview...' : 'Voice preview (Bulbul v3 · ritu)'}
        </button>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Voice preview:
          </span>
          <audio ref={audioRef} controls className="h-8 max-w-[220px]" />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900"
        >
          <strong>Call Failed:</strong> {error}
        </div>
      )}

      {callDetail && (
        <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950">
          <strong>Live Call ({fullName}):</strong> {callDetail}
        </div>
      )}

      {previewScript && (
        <div className="p-2.5 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] text-xs text-slate-700">
          <span className="font-semibold text-[#0B1220]">Voice preview script (Ritu · ta-IN):</span>{' '}
          &ldquo;{previewScript}&rdquo;
        </div>
      )}
    </div>
  );
}
