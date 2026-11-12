'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export function LiveNilaCallButton({
  leadId,
  phoneE164,
  fullName,
}: {
  leadId: string;
  phoneE164: string;
  fullName: string;
}) {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    pstnStatus: string;
    pstnDetail: string;
    spokenScript: string;
    audioBase64?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCallNow() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/voice/call-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(data);
      if (data.audioBase64 && audioRef.current) {
        audioRef.current.src = `data:audio/wav;base64,${data.audioBase64}`;
        await audioRef.current.play().catch(() => undefined);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Call failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-2 pt-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={loading}
          onClick={handleCallNow}
          className="px-4 py-2 rounded-lg bg-[#149642] hover:bg-[#0F7633] text-white text-xs font-bold shadow-sm cursor-pointer"
        >
          {loading
            ? `Calling ${phoneE164} with Agent Nila...`
            : `Call ${phoneE164} Now with Live Nila Voice (Bulbul v3 · ishita)`}
        </button>
        <audio ref={audioRef} controls className="h-8 max-w-xs" />
      </div>

      {error && (
        <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900">
          {error}
        </div>
      )}

      {result && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 space-y-1">
          <div className="font-bold">
            Nila Voice Call Active for {fullName} ({phoneE164}):
          </div>
          <p className="font-medium">&ldquo;{result.spokenScript}&rdquo;</p>
          <p className="text-[11px] text-slate-600">{result.pstnDetail}</p>
        </div>
      )}
    </div>
  );
}

