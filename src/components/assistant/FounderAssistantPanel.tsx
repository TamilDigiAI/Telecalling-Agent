'use client';

import React, { useRef, useState } from 'react';

export function FounderAssistantPanel() {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/assistant/nila-voice-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'full', transcript: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (HTTP ${res.status})`);
      }
      setReply(data.dialogue?.replyText ?? 'No reply returned.');
      if (data.tts?.audioBase64 && audioRef.current) {
        audioRef.current.src = `data:${data.tts.mimeType || 'audio/wav'};base64,${data.tts.audioBase64}`;
        await audioRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assistant request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
      <h2 className="text-base font-bold text-[#0B1220]">Ask Nila</h2>
      <form onSubmit={handleAsk} className="flex flex-col sm:flex-row gap-2.5">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a question for Nila in Tamil or English..."
          aria-label="Message Nila Assistant"
          className="flex-1 rounded-lg border border-[#E2E8E2] px-3 py-2 text-sm text-[#0B1220]"
        />
        <button
          type="submit"
          disabled={loading || !message.trim()}
          className={`px-4 py-2 rounded-lg text-sm font-semibold text-white whitespace-nowrap ${
            loading || !message.trim()
              ? 'bg-slate-400 cursor-not-allowed'
              : 'bg-[#149642] hover:bg-[#0F7633] cursor-pointer'
          }`}
        >
          {loading ? 'Thinking...' : 'Ask Nila'}
        </button>
      </form>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900">
          {error}
        </div>
      )}

      {reply && (
        <div className="p-4 rounded-xl bg-[#F7F9F6] border border-[#E2E8E2] space-y-3">
          <p className="text-sm text-[#0B1220]">{reply}</p>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase text-slate-500">
              Voice preview:
            </span>
            <audio ref={audioRef} controls className="h-8 max-w-xs" />
          </div>
        </div>
      )}
    </section>
  );
}
