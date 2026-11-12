import { DEFAULT_VOICE_AGENT_NAME } from '@/lib/env';
import {
  buildApprovedPricingReply,
  DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  evaluateCallbackSlotVerification,
  type BusinessKnowledgeSettings,
} from '@/lib/knowledge/business-settings';
import type {
  CallOutcome,
  Lead,
  LeadTemperature,
  RecordCallOutcomeInput,
  StructuredCallExtraction,
} from '@/types/crm';

export type MockCallScenario =
  | 'HOT_CALLBACK'
  | 'WARM_INTEREST'
  | 'NO_ANSWER'
  | 'OPT_OUT_DNC'
  | 'PRICING_NO_APPROVED_RATE';

export interface MockTelephonySimulationResult {
  provider: 'exotel_mock';
  agentName: string;
  scenario: MockCallScenario;
  callOutcome: CallOutcome;
  proposedTemperature: LeadTemperature;
  qualificationReason: string;
  summary: string;
  callbackAt: string | null;
  optOut: boolean;
  durationSeconds: number;
  structuredExtraction: StructuredCallExtraction;
  dialoguePreview: Array<{ speaker: string; text: string }>;
}

/**
 * Computes a deterministic next-day 11:00 AM Asia/Kolkata (05:30 UTC) callback timestamp.
 */
export function getNextDayMorningCallbackIst(referenceDate: Date = new Date()): string {
  const nextDay = new Date(referenceDate.getTime() + 24 * 60 * 60 * 1000);
  const year = nextDay.getUTCFullYear();
  const month = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
  const day = String(nextDay.getUTCDate()).padStart(2, '0');
  // 11:00 AM IST = 05:30 UTC
  return `${year}-${month}-${day}T05:30:00.000Z`;
}

/**
 * Simulates an outbound call in mock mode with DigiAnchorZ voice agent "Nila"
 * using the workspace's configured BusinessKnowledgeSettings.
 */
export function simulateOutboundCallWithNila(
  lead: Pick<
    Lead,
    'id' | 'workspace_id' | 'full_name' | 'service_interest' | 'phone_e164'
  > & { do_not_call?: boolean },
  scenario: MockCallScenario = 'HOT_CALLBACK',
  agentName: string = DEFAULT_VOICE_AGENT_NAME,
  customCallbackAt?: string,
  settings: BusinessKnowledgeSettings = DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS
): MockTelephonySimulationResult {
  if (lead.do_not_call) {
    throw new Error(
      `Call blocked: lead ${lead.full_name} (${lead.phone_e164}) has opted out (DO_NOT_CALL suppression active)`
    );
  }

  const callbackIso = customCallbackAt || getNextDayMorningCallbackIst();
  const opening1 = settings.outbound_script.opening_identity_check.replace(
    '[Name]',
    lead.full_name
  );
  const opening2 = settings.outbound_script.opening_permission_after_confirmation.replace(
    '[Service]',
    lead.service_interest
  );

  if (scenario === 'HOT_CALLBACK') {
    const slotEval = evaluateCallbackSlotVerification(settings, 'நாளைக்கு காலை 11:00 AM');
    return {
      provider: 'exotel_mock',
      agentName,
      scenario,
      callOutcome: 'CALLBACK_REQUESTED',
      proposedTemperature: 'HOT',
      qualificationReason:
        'Meta Ads enquiry with current lead-generation need and agreed callback with MD Tamilselvan Marimuthu tomorrow at 11:00 AM IST.',
      summary: `Agent ${agentName} verified identity and qualified ${lead.full_name} for ${lead.service_interest}. Lead has an immediate need and agreed to a callback with MD ${settings.founder_name} at 11:00 AM IST.`,
      callbackAt: callbackIso,
      optOut: false,
      durationSeconds: 118,
      structuredExtraction: {
        agent_name: agentName,
        need: `Consistent qualified enquiries via ${lead.service_interest}`,
        timeline: 'Immediate (this month)',
        budget_band: 'INR 40,000 - 75,000 / month ad spend',
        next_action: `Agreed callback with MD ${settings.founder_name} tomorrow 11:00 AM IST`,
        transcript_highlights: [
          `${agentName}: "${opening1}"`,
          `${agentName}: "${opening2}"`,
          `${agentName}: "${settings.outbound_script.questions.next_step}"`,
          `${lead.full_name}: "சரிங்க, நாளைக்கு காலைல 11:00 AM IST-க்கு call பண்ண சொல்லுங்க."`,
          `${agentName}: "${slotEval.spokenConfirmationText}"`,
        ],
      },
      dialoguePreview: [
        { speaker: agentName, text: opening1 },
        { speaker: lead.full_name, text: 'ஆமாங்க, நான்தான் பேசுறேன்.' },
        { speaker: agentName, text: opening2 },
        { speaker: lead.full_name, text: 'பேசலாங்க, இப்போ enquiries ரொம்ப குறைவா வருது.' },
        { speaker: agentName, text: settings.outbound_script.questions.timing },
        { speaker: lead.full_name, text: 'இந்த வாரமே start பண்ணணும்ங்க.' },
        { speaker: agentName, text: settings.outbound_script.questions.next_step },
        { speaker: lead.full_name, text: 'நாளைக்கு காலை 11:00 AM IST-க்கு பேசலாங்க.' },
        { speaker: agentName, text: slotEval.spokenConfirmationText },
      ],
    };
  }

  if (scenario === 'WARM_INTEREST') {
    return {
      provider: 'exotel_mock',
      agentName,
      scenario,
      callOutcome: 'CONNECTED',
      proposedTemperature: 'WARM',
      qualificationReason:
        'Relevant interest in Meta Ads, but start timing and next step are still undecided.',
      summary: `Agent ${agentName} spoke with ${lead.full_name} about ${lead.service_interest}. Lead is interested but has not decided on timing or a confirmed callback slot yet.`,
      callbackAt: null,
      optOut: false,
      durationSeconds: 82,
      structuredExtraction: {
        agent_name: agentName,
        need: lead.service_interest,
        timeline: 'Undecided (next month)',
        budget_band: 'Not finalized',
        next_action: 'Timing and next step undecided',
      },
      dialoguePreview: [
        { speaker: agentName, text: opening1 },
        { speaker: lead.full_name, text: 'ஆமாங்க, அடுத்த மாசம் தான் campaign start பண்ண போறோம், timing இன்னும் fix பண்ணல.' },
      ],
    };
  }

  if (scenario === 'PRICING_NO_APPROVED_RATE') {
    const pricingEval = buildApprovedPricingReply(settings);
    return {
      provider: 'exotel_mock',
      agentName,
      scenario,
      callOutcome: 'CALLBACK_REQUESTED',
      proposedTemperature: 'WARM',
      qualificationReason:
        'Lead asked "How much do you charge?" while approved service fees are blank; Nila gave the approved response without inventing a quote and created a founder quote follow-up.',
      summary: `${lead.full_name} asked for pricing on ${lead.service_interest}. Because no approved rate is configured, ${agentName} used the approved response ("${settings.approved_faqs.how_much_do_you_charge}") without inventing a price, kept agency fees and ad spend distinct, and scheduled a founder follow-up.`,
      callbackAt: callbackIso,
      optOut: false,
      durationSeconds: 90,
      structuredExtraction: {
        agent_name: agentName,
        need: `${lead.service_interest} — pricing clarification requested`,
        timeline: 'Exploring quote',
        budget_band: null,
        next_action: `Founder quote follow-up scheduled with ${settings.founder_name}`,
        pricing_question_without_approved_rate: !pricingEval.hasApprovedQuoteRange,
        invented_quote: null,
        transcript_highlights: [
          `${lead.full_name}: "How much do you charge for Meta Ads?"`,
          `${agentName}: "${pricingEval.replyText}"`,
        ],
      },
      dialoguePreview: [
        { speaker: agentName, text: opening1 },
        { speaker: lead.full_name, text: 'ஆமாங்க, நீங்க Meta Ads-க்கு எவ்வளவு charge பண்ணுவீங்க? How much do you charge?' },
        { speaker: agentName, text: pricingEval.replyText },
      ],
    };
  }

  if (scenario === 'OPT_OUT_DNC') {
    return {
      provider: 'exotel_mock',
      agentName,
      scenario,
      callOutcome: 'DO_NOT_CALL',
      proposedTemperature: 'COLD',
      qualificationReason: 'Lead explicitly requested Do Not Call ("இனிமேல் call பண்ண வேண்டாம்").',
      summary: `${lead.full_name} requested to stop receiving calls. Agent ${agentName} acknowledged politely and saved the opt-out immediately.`,
      callbackAt: null,
      optOut: true,
      durationSeconds: 34,
      structuredExtraction: {
        agent_name: agentName,
        need: null,
        timeline: null,
        budget_band: null,
        next_action: 'Suppressed (Do Not Call)',
      },
      dialoguePreview: [
        { speaker: agentName, text: opening1 },
        { speaker: lead.full_name, text: 'இனிமேல் call பண்ண வேண்டாம்ங்க, நாங்க வேற மாதிரி பாத்துக்குறோம்.' },
        { speaker: agentName, text: 'சரிங்க, உங்க நம்பரை உடனே Do-Not-Call லிஸ்ட்ல நோட் பண்ணிக்கிட்டேன். நன்றிங்க, வணக்கம்.' },
      ],
    };
  }

  return {
    provider: 'exotel_mock',
    agentName,
    scenario: 'NO_ANSWER',
    callOutcome: 'NO_ANSWER',
    proposedTemperature: 'UNQUALIFIED',
    qualificationReason: 'No answer on outbound call; missed call stays UNQUALIFIED and does not mark lead Cold.',
    summary: `Outbound dial by Agent ${agentName} went unanswered.`,
    callbackAt: null,
    optOut: false,
    durationSeconds: 0,
    structuredExtraction: {
      agent_name: agentName,
    },
    dialoguePreview: [],
  };
}

export function buildRecordOutcomeInputFromSimulation(
  lead: Pick<Lead, 'id' | 'workspace_id'>,
  sim: MockTelephonySimulationResult,
  callAttemptId?: string
): RecordCallOutcomeInput {
  return {
    workspaceId: lead.workspace_id,
    leadId: lead.id,
    callOutcome: sim.callOutcome,
    proposedTemperature: sim.proposedTemperature,
    qualificationReason: sim.qualificationReason,
    summary: sim.summary,
    callbackAt: sim.callbackAt,
    optOut: sim.optOut,
    callAttemptId: callAttemptId ?? null,
    structuredExtraction: sim.structuredExtraction,
    durationSeconds: sim.durationSeconds,
  };
}
