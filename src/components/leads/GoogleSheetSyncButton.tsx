'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GoogleSheetSyncButton({ sheetId }: { sheetId: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function handleSync() {
    setSyncing(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/sheets/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStatusMessage(
        `${data.pullResult?.statusMessage ?? ''} ${data.pushResult?.details ?? ''}`.trim()
      );
      router.refresh();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col sm:items-end gap-1.5">
      <button
        type="button"
        disabled={syncing}
        onClick={handleSync}
        className="px-3.5 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-xs font-bold shadow-sm cursor-pointer"
      >
        {syncing ? 'Syncing Test Leads...' : `Sync Test Leads (${sheetId.slice(0, 8)}...)`}
      </button>
      {statusMessage && (
        <span className="text-[11px] font-medium text-[#0F7633] bg-[#149642]/10 px-2.5 py-1 rounded">
          {statusMessage}
        </span>
      )}
    </div>
  );
}

