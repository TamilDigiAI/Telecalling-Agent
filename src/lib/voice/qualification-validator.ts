import { z } from 'zod';
import type { CallOutcome, LeadTemperature, StructuredCallExtraction } from '@/types/crm';

export const structuredCallOutcomeSchema = z.object({
  callOutcome: z.enum([
    'CONNECTED',
    'CALLBACK_REQUESTED',
    'NO_ANSWER',
    'BUSY',
    'FAILED',
    'VOICEMAIL',
    'WRONG_NUMBER',
    'DO_NOT_CALL',
  ]),
  proposedTemperature: z.enum(['HOT', 'WARM', 'COLD', 'UNQUALIFIED']),
  qualificationReason: z.string().min(1).max(600),
  summary: z.string().min(1).max(1200),
  callbackAt: z.string().datetime({ offset: true }).nullable().optional(),
  optOut: z.boolean().optional().default(false),
  need: z.string().max(400).nullable().optional(),
  timeline: z.string().max(200).nullable().optional(),
  budgetBand: z.string().max(200).nullable().optional(),
  nextAction: z.string().max(400).nullable().optional(),
  pricingQuestionWithoutApprovedRate: z.boolean().optional().default(false),
});

export type RawStructuredModelOutcome = z.input<typeof structuredCallOutcomeSchema>;

export interface ValidatedCallQualification {
  callOutcome: CallOutcome;
  appliedTemperature: LeadTemperature;
  qualificationReason: string;
  summary: string;
  callbackAt: string | null;
  optOut: boolean;
  structuredExtraction: StructuredCallExtraction;
  downgradedFromHot: boolean;
}

const UNANSWERED_OUTCOMES: ReadonlySet<CallOutcome> = new Set([
  'NO_ANSWER',
  'BUSY',
  'FAILED',
  'VOICEMAIL',
]);

/**
 * Server-side validation of structured model output.
 * Enforces:
 * - HOT requires a current need AND an agreed concrete next step or confirmed callback time.
 * - Unanswered attempts preserve any earlier qualification (HOT, WARM, or COLD).
 * - Opt-outs are flagged immediately regardless of proposed temperature.
 */
export function validateStructuredCallOutcome(
  rawInput: unknown,
  priorTemperature: LeadTemperature = 'UNQUALIFIED'
): ValidatedCallQualification {
  const parsed = structuredCallOutcomeSchema.parse(rawInput);
  const optOut = Boolean(parsed.optOut || parsed.callOutcome === 'DO_NOT_CALL');

  let appliedTemperature: LeadTemperature = parsed.proposedTemperature;
  let qualificationReason = parsed.qualificationReason.trim();
  let downgradedFromHot = false;

  if (UNANSWERED_OUTCOMES.has(parsed.callOutcome)) {
    appliedTemperature =
      priorTemperature === 'HOT' || priorTemperature === 'WARM' || priorTemperature === 'COLD'
        ? priorTemperature
        : 'UNQUALIFIED';
  } else if (appliedTemperature === 'HOT') {
    const hasNeed = Boolean(parsed.need && parsed.need.trim().length > 0);
    const hasConcreteNextStep = Boolean(
      parsed.callbackAt || (parsed.nextAction && parsed.nextAction.trim().length > 0)
    );
    if (!hasNeed || !hasConcreteNextStep) {
      appliedTemperature = 'WARM';
      downgradedFromHot = true;
      qualificationReason = `${qualificationReason} (Server guardrail: downgraded from HOT to WARM because current need and concrete next step/callback are both required.)`;
    }
  }

  return {
    callOutcome: parsed.callOutcome,
    appliedTemperature,
    qualificationReason,
    summary: parsed.summary.trim(),
    callbackAt: parsed.callbackAt ?? null,
    optOut,
    downgradedFromHot,
    structuredExtraction: {
      agent_name: 'Nila',
      need: parsed.need ?? null,
      timeline: parsed.timeline ?? null,
      budget_band: parsed.budgetBand ?? null,
      next_action: parsed.nextAction ?? (parsed.callbackAt ? 'Founder callback scheduled' : null),
      pricing_question_without_approved_rate: parsed.pricingQuestionWithoutApprovedRate,
    },
  };
}

/**
 * Checks whether the current time in Asia/Kolkata (IST) falls within workspace permitted hours.
 */
export function isWithinPermittedIstHours(
  startHourIst: number,
  endHourIst: number,
  now: Date = new Date()
): { allowed: boolean; currentHourIst: number } {
  const istHourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  }).format(now);
  const currentHourIst = Number(istHourStr) % 24;
  return {
    allowed: currentHourIst >= startHourIst && currentHourIst < endHourIst,
    currentHourIst,
  };
}
