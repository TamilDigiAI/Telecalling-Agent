'use client';

import React, { useState } from 'react';
import { NilaVoiceTestPanel } from '@/components/assistant/NilaVoiceTestPanel';
import {
  processPendingSheetSyncJobsServerAction,
  runMockOutboundCallAction,
} from '@/app/actions/crm';
import type { Lead } from '@/types/crm';

export function DeveloperToolsSection({
  leads,
  sttModel,
  sttMode,
  ttsModel,
  ttsSpeaker,
  ttsLanguage,
  llmModel,
  vobizUrls,
}: {
  leads: Lead[];
  sttModel: string;
  sttMode: string;
  ttsModel: string;
  ttsSpeaker: string;
  ttsLanguage: string;
  llmModel: string;
  vobizUrls: {
    answerUrl: string;
    hangupUrl: string;
    statusUrl: string;
    streamStatusUrl: string;
    wssStreamUrl: string;
  };
}) {
  const [enabled, setEnabled] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState(leads[0]?.id ?? '');

  return (
    <section className="bg-white border border-[#E2E8E2] rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[#0B1220]">Developer Tools</h2>
          <p className="text-xs text-slate-500">
            Simulation, audio-preview, webhook endpoints, and integration-testing controls.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((prev) => !prev)}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
            enabled
              ? 'bg-[#0B1220] text-white border-[#0B1220]'
              : 'bg-white text-[#0B1220] border-[#E2E8E2] hover:bg-slate-50'
          }`}
        >
          {enabled ? 'Hide Developer Tools' : 'Enable Developer Tools'}
        </button>
      </div>

      {enabled && (
        <div className="space-y-5 pt-3 border-t border-[#E2E8E2]">
          {/* 1. Mock Call Simulations */}
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-[#0B1220]">Mock Call Simulations</h3>
            {leads.length === 0 ? (
              <p className="text-xs text-slate-500">No leads available for simulation.</p>
            ) : (
              <div className="space-y-3">
                <select
                  value={selectedLeadId}
                  onChange={(e) => setSelectedLeadId(e.target.value)}
                  aria-label="Select lead for simulation"
                  className="rounded-lg border border-[#E2E8E2] px-3 py-2 text-xs bg-white w-full max-w-md"
                >
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.full_name} ({l.phone_e164}) — {l.external_lead_id}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  {[
                    { scenario: 'HOT_CALLBACK', label: 'Simulate HOT Callback' },
                    { scenario: 'WARM_INTEREST', label: 'Simulate WARM' },
                    { scenario: 'NO_ANSWER', label: 'Simulate NO_ANSWER' },
                    { scenario: 'PRICING_NO_APPROVED_RATE', label: 'Simulate Pricing Question' },
                    { scenario: 'OPT_OUT_DNC', label: 'Simulate Opt-Out (DNC)' },
                  ].map((item) => (
                    <form key={item.scenario} action={runMockOutboundCallAction}>
                      <input type="hidden" name="leadId" value={selectedLeadId} />
                      <input type="hidden" name="scenario" value={item.scenario} />
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg border border-[#E2E8E2] bg-[#F7F9F6] hover:bg-slate-100 text-xs font-semibold text-[#0B1220] cursor-pointer"
                      >
                        {item.label}
                      </button>
                    </form>
                  ))}
                  <form action={processPendingSheetSyncJobsServerAction}>
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-[#FBB61B] text-[#0B1220] text-xs font-semibold cursor-pointer"
                    >
                      Run Sheet Sync Worker
                    </button>
                  </form>
                </div>
              </div>
            )}
          </div>

          {/* 2. Vobiz Webhook & WSS Endpoints */}
          <div className="p-3.5 rounded-lg bg-[#F7F9F6] border border-[#E2E8E2] text-xs space-y-1">
            <div className="font-semibold text-[#0B1220]">Vobiz Webhook &amp; Stream Endpoints</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 font-mono text-[11px] text-slate-700">
              <div>Answer XML: {vobizUrls.answerUrl}</div>
              <div>Hangup: {vobizUrls.hangupUrl}</div>
              <div>Status: {vobizUrls.statusUrl}</div>
              <div>Stream Status: {vobizUrls.streamStatusUrl}</div>
              <div className="md:col-span-2">WSS Stream: {vobizUrls.wssStreamUrl}</div>
            </div>
          </div>

          {/* 3. Audio Preview & Sarvam Stage Testing */}
          <NilaVoiceTestPanel
            sttModel={sttModel}
            sttMode={sttMode}
            ttsModel={ttsModel}
            ttsSpeaker={ttsSpeaker}
            ttsLanguage={ttsLanguage}
            llmModel={llmModel}
          />
        </div>
      )}
    </section>
  );
}
