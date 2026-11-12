'use client';

import React from 'react';

export default function GlobalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#F7F9F6] text-[#0B1220]">
      <div className="max-w-md w-full bg-white border border-[#E2E8E2] rounded-2xl p-6 shadow-sm space-y-4">
        <h2 className="text-lg font-bold text-[#0B1220]">DigiAnchorZ CRM Reload</h2>
        <p className="text-xs text-slate-600">
          {error?.message || 'A temporary page reload is needed after hot-reload.'}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="px-4 py-2 rounded-lg bg-[#0F7633] hover:bg-[#149642] text-white text-xs font-semibold cursor-pointer"
          >
            Try Again
          </button>
          <a
            href="/"
            className="px-4 py-2 rounded-lg border border-[#E2E8E2] text-xs font-semibold text-[#0B1220]"
          >
            Go to Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

