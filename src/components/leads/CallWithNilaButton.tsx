'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type CallUiState = 'Ready' | 'Dialing' | 'Ringing' | 'Connected' | 'Completed' | 'Failed';

export function CallWithNilaButton({
  leadId,
  phoneE164,
  eligible = true,
  doNotCall = false,
  compact = false,
}: {
  leadId: string;
  phoneE164: string;
  eligible?: boolean;
  doNotCall?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const inFlightRef = useRef(false);

  const [callState, setCallState] = useState<CallUiState>('Ready');
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          if (data.error) setError(data.error);
          if (data.callState === 'Completed' || data.callState === 'Failed') {
            router.refresh();
          }
        }
      } catch {
        // Ignore transient poll error
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [attemptId, callState, router]);

  async function handleCall(e: React.MouseEvent) {
    e.stopPropagation();
    if (inFlightRef.current || !eligible || doNotCall) return;
    inFlightRef.current = true;
    setError(null);
    setCallState('Dialing');

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
        setError(data.error || `Call failed (HTTP ${res.status})`);
        return;
      }
      setAttemptId(data.attemptId ?? null);
      setCallState((data.callState as CallUiState) || 'Dialing');
      router.refresh();
    } catch (err) {
      setCallState('Failed');
      setError(err instanceof Error ? err.message : 'Call request failed');
    } finally {
      inFlightRef.current = false;
    }
  }

  const isPending = callState === 'Dialing' || callState === 'Ringing' || callState === 'Connected';
  const disabled = isPending || !eligible || doNotCall;

  return (
    <div className="flex flex-col items-start gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={handleCall}
        aria-label={`Call ${phoneE164} with Nila`}
        className={`${
          compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
        } rounded-lg font-semibold text-white whitespace-nowrap transition-colors ${
          disabled
            ? 'bg-slate-400 cursor-not-allowed'
            : 'bg-[#149642] hover:bg-[#0F7633] cursor-pointer'
        }`}
      >
        {callState === 'Dialing'
          ? 'Dialing...'
          : callState === 'Ringing'
            ? 'Ringing...'
            : callState === 'Connected'
              ? 'Connected'
              : doNotCall
                ? 'Do Not Call'
                : 'Call with Nila'}
      </button>
      {error && (
        <span role="alert" className="text-[11px] text-red-700 max-w-[240px] leading-snug">
          {error}
        </span>
      )}
    </div>
  );
}
