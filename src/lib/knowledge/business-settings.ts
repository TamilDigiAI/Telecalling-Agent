import { z } from 'zod';

export const DIGIANCHORZ_SERVICE_CATALOG = [
  'Meta Ads for Facebook and Instagram lead generation',
  'Google Ads for search-driven enquiries',
  'SEO and Local SEO for search visibility',
  'Website and landing page development',
  'WhatsApp automation, lead follow-up, and CRM workflows',
  'Branding and video content production',
] as const;

export interface FounderBlankSettings {
  /** Approved service fees or quote ranges (blank until founder fills in) */
  approved_service_fees: string;
  /** Minimum ad budget, if any (blank until founder fills in) */
  minimum_ad_budget: string;
  /** Whether a discovery call is free or paid (blank until founder fills in) */
  discovery_call_fee_policy: string;
  /** Callback days, available time slots, and meeting duration (blank until founder fills in) */
  callback_schedule: string;
  /** Founder or team member responsible for each type of enquiry (blank until founder fills in) */
  escalation_contacts: string;
  /** Approved client examples, results, and testimonials (blank until founder fills in) */
  approved_proof_points: string;
  /** Service locations and any exclusions (blank until founder fills in) */
  service_locations_and_exclusions: string;
}

export interface ApprovedFaqResponses {
  how_much_do_you_charge: string;
  can_you_guarantee_leads_or_sales: string;
  we_already_have_an_agency: string;
  just_send_me_the_details: string;
}

export interface OutboundSalesScriptConfig {
  opening_identity_check: string;
  opening_permission_after_confirmation: string;
  questions: {
    situation: string;
    problem: string;
    impact: string;
    timing: string;
    budget: string;
    next_step: string;
  };
}

export interface BusinessKnowledgeSettings {
  business_name: string;
  founder_name: string;
  location: string;
  website: string;
  positioning: string;
  default_language: string;
  pilot_primary_service: string;
  service_catalog: string[];
  founder_settings: FounderBlankSettings;
  outbound_script: OutboundSalesScriptConfig;
  approved_faqs: ApprovedFaqResponses;
}

export const DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS: BusinessKnowledgeSettings = {
  business_name: 'DigiAnchorZ',
  founder_name: 'Tamilselvan Marimuthu',
  location: 'Karur, Tamil Nadu',
  website: 'https://digianchorz.com',
  positioning: 'AI-driven digital marketing and automation agency.',
  default_language: 'Natural Tamil Nadu Tanglish',
  pilot_primary_service: 'Meta Ads for Facebook and Instagram lead generation',
  service_catalog: [...DIGIANCHORZ_SERVICE_CATALOG],
  // Must remain blank until the founder explicitly fills them in
  founder_settings: {
    approved_service_fees: '',
    minimum_ad_budget: '',
    discovery_call_fee_policy: '',
    callback_schedule: '',
    escalation_contacts: '',
    approved_proof_points: '',
    service_locations_and_exclusions: '',
  },
  outbound_script: {
    opening_identity_check:
      'வணக்கம், நான் நிலா, DigiAnchorZ-ஓட AI enquiry assistant. [Name] கிட்டதான் பேசுறேனா?',
    opening_permission_after_confirmation:
      'நீங்க [Service] பத்தி enquiry பண்ணியிருந்தீங்க. இப்போ ரெண்டு நிமிஷம் பேசலாமா?',
    questions: {
      situation: 'உங்க business என்ன? இப்போ enquiries எப்படி வருது?',
      problem:
        'இப்போ உங்களுக்கு என்ன சிரமமா இருக்கு? Enquiries குறைவா வருதா, இல்ல வந்த enquiries sales-ஆ மாறலையா?',
      impact: 'இந்த issue உங்க sales-ஐ எப்படி பாதிக்குது?',
      timing: 'இதை எப்போ start பண்ணணும்னு யோசிக்கிறீங்க?',
      budget: 'Ads-க்கு ஒரு monthly budget range யோசிச்சிருக்கீங்களா?',
      next_step:
        'enga MD தமிழ்செல்வன் sir கிட்ட ஒரு short callback arrange பண்ணலாமா? உங்களுக்கு endha timing convenient ah இருக்கும்?',
    },
  },
  approved_faqs: {
    how_much_do_you_charge:
      'உங்க goal, campaign scope, ad budget தெரிஞ்சா team சரியான quote சொல்ல முடியும்.',
    can_you_guarantee_leads_or_sales:
      'Campaign setup, tracking, optimization பண்ண முடியும். Results உங்க offer, audience, budget, follow-up இதைப் பொறுத்து மாறும்.',
    we_already_have_an_agency:
      'சரி. இப்போ எந்த விஷயம் இன்னும் better-ஆ இருந்தா உங்களுக்கு useful-ஆ இருக்கும்?',
    just_send_me_the_details:
      'உங்களுக்கு எந்த service details வேணும், எந்த channel-ல (WhatsApp / Email) அனுப்பணும்னு நோட் பண்ணிக்கிட்டேன்ங்க. எங்க team உங்களுக்கு அனுப்பி வைப்பாங்க.',
  },
};

export const businessSettingsUpdateSchema = z.object({
  business_name: z.string().min(1).default('DigiAnchorZ'),
  founder_name: z.string().min(1).default('Tamilselvan Marimuthu'),
  location: z.string().min(1).default('Karur, Tamil Nadu'),
  website: z.string().url().default('https://digianchorz.com'),
  positioning: z.string().min(1),
  default_language: z.string().min(1),
  pilot_primary_service: z.string().min(1),
  service_catalog: z.array(z.string().min(1)).min(1),
  founder_settings: z.object({
    approved_service_fees: z.string().default(''),
    minimum_ad_budget: z.string().default(''),
    discovery_call_fee_policy: z.string().default(''),
    callback_schedule: z.string().default(''),
    escalation_contacts: z.string().default(''),
    approved_proof_points: z.string().default(''),
    service_locations_and_exclusions: z.string().default(''),
  }),
  approved_faqs: z.object({
    how_much_do_you_charge: z.string().min(1),
    can_you_guarantee_leads_or_sales: z.string().min(1),
    we_already_have_an_agency: z.string().min(1),
    just_send_me_the_details: z.string().min(1),
  }),
});

/**
 * Merges stored JSONB workspace business_profile with defaults so all fields are guaranteed present,
 * preserving blank founder settings unless explicitly populated by the founder.
 */
export function resolveBusinessKnowledgeSettings(
  rawProfile?: Record<string, unknown> | null
): BusinessKnowledgeSettings {
  if (!rawProfile || typeof rawProfile !== 'object') {
    return structuredClone(DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS);
  }

  const rawFounder =
    (rawProfile.founder_settings as Partial<FounderBlankSettings> | undefined) ?? {};
  const rawFaqs =
    (rawProfile.approved_faqs as Partial<ApprovedFaqResponses> | undefined) ?? {};
  const rawScript =
    (rawProfile.outbound_script as Partial<OutboundSalesScriptConfig> | undefined) ?? {};

  const catalog = Array.isArray(rawProfile.service_catalog)
    ? rawProfile.service_catalog.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [...DIGIANCHORZ_SERVICE_CATALOG];

  return {
    business_name:
      typeof rawProfile.business_name === 'string' && rawProfile.business_name.trim()
        ? rawProfile.business_name.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.business_name,
    founder_name:
      typeof rawProfile.founder_name === 'string' && rawProfile.founder_name.trim()
        ? rawProfile.founder_name.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.founder_name,
    location:
      typeof rawProfile.location === 'string' && rawProfile.location.trim()
        ? rawProfile.location.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.location,
    website:
      typeof rawProfile.website === 'string' && rawProfile.website.trim()
        ? rawProfile.website.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.website,
    positioning:
      typeof rawProfile.positioning === 'string' && rawProfile.positioning.trim()
        ? rawProfile.positioning.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.positioning,
    default_language:
      typeof rawProfile.default_language === 'string' && rawProfile.default_language.trim()
        ? rawProfile.default_language.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.default_language,
    pilot_primary_service:
      typeof rawProfile.pilot_primary_service === 'string' && rawProfile.pilot_primary_service.trim()
        ? rawProfile.pilot_primary_service.trim()
        : DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.pilot_primary_service,
    service_catalog: catalog.length > 0 ? catalog : [...DIGIANCHORZ_SERVICE_CATALOG],
    founder_settings: {
      approved_service_fees:
        typeof rawFounder.approved_service_fees === 'string'
          ? rawFounder.approved_service_fees.trim()
          : '',
      minimum_ad_budget:
        typeof rawFounder.minimum_ad_budget === 'string'
          ? rawFounder.minimum_ad_budget.trim()
          : '',
      discovery_call_fee_policy:
        typeof rawFounder.discovery_call_fee_policy === 'string'
          ? rawFounder.discovery_call_fee_policy.trim()
          : '',
      callback_schedule:
        typeof rawFounder.callback_schedule === 'string'
          ? rawFounder.callback_schedule.trim()
          : '',
      escalation_contacts:
        typeof rawFounder.escalation_contacts === 'string'
          ? rawFounder.escalation_contacts.trim()
          : '',
      approved_proof_points:
        typeof rawFounder.approved_proof_points === 'string'
          ? rawFounder.approved_proof_points.trim()
          : '',
      service_locations_and_exclusions:
        typeof rawFounder.service_locations_and_exclusions === 'string'
          ? rawFounder.service_locations_and_exclusions.trim()
          : '',
    },
    outbound_script: {
      opening_identity_check:
        rawScript.opening_identity_check ||
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.outbound_script.opening_identity_check,
      opening_permission_after_confirmation:
        rawScript.opening_permission_after_confirmation ||
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.outbound_script
          .opening_permission_after_confirmation,
      questions: {
        ...DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.outbound_script.questions,
        ...(rawScript.questions ?? {}),
      },
    },
    approved_faqs: {
      how_much_do_you_charge:
        rawFaqs.how_much_do_you_charge ||
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.approved_faqs.how_much_do_you_charge,
      can_you_guarantee_leads_or_sales:
        rawFaqs.can_you_guarantee_leads_or_sales ||
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.approved_faqs.can_you_guarantee_leads_or_sales,
      we_already_have_an_agency:
        rawFaqs.we_already_have_an_agency ||
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.approved_faqs.we_already_have_an_agency,
      just_send_me_the_details:
        rawFaqs.just_send_me_the_details ||
        DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS.approved_faqs.just_send_me_the_details,
    },
  };
}

/**
 * Produces the approved pricing response without ever inventing a rate when approved_service_fees is blank.
 * Keeps agency fees and advertising spend distinct.
 */
export function buildApprovedPricingReply(settings: BusinessKnowledgeSettings): {
  replyText: string;
  hasApprovedQuoteRange: boolean;
  requiresFounderFollowUp: boolean;
} {
  const configuredFees = settings.founder_settings.approved_service_fees.trim();
  const minAdBudget = settings.founder_settings.minimum_ad_budget.trim();

  if (!configuredFees) {
    return {
      replyText: `${settings.approved_faqs.how_much_do_you_charge} Agency service fee மற்றும் ad spend ரெண்டும் தனித்தனிங்க; எங்க MD ${settings.founder_name} sir டீம் உங்ககிட்ட பேசி தெளிவா quote சொல்லுவாங்கங்க.`,
      hasApprovedQuoteRange: false,
      requiresFounderFollowUp: true,
    };
  }

  const budgetNote = minAdBudget ? ` Minimum ad budget: ${minAdBudget}.` : '';
  return {
    replyText: `${settings.approved_faqs.how_much_do_you_charge} Approved fee range: ${configuredFees}.${budgetNote} (Agency fee மற்றும் ad spend தனித்தனிங்க).`,
    hasApprovedQuoteRange: true,
    requiresFounderFollowUp: false,
  };
}

/**
 * Checks whether a callback slot can be verified against founder settings.
 * If callback_schedule is blank, the callback must be saved as a request for founder review
 * rather than claimed as a verified slot booking.
 */
export function evaluateCallbackSlotVerification(
  settings: BusinessKnowledgeSettings,
  requestedTimeIst: string
): {
  slotVerified: boolean;
  taskType: 'FOUNDER_CALLBACK' | 'MANUAL_REVIEW';
  spokenConfirmationText: string;
} {
  const schedule = settings.founder_settings.callback_schedule.trim();
  if (!schedule) {
    return {
      slotVerified: false,
      taskType: 'MANUAL_REVIEW',
      spokenConfirmationText: `${requestedTimeIst} IST callback request-ஐ எங்க MD ${settings.founder_name} sir review-க்கு நோட் பண்ணிக்கிட்டேன்ங்க; team slot check பண்ணிட்டு confirm பண்ணுவாங்கங்க.`,
    };
  }

  return {
    slotVerified: true,
    taskType: 'FOUNDER_CALLBACK',
    spokenConfirmationText: `சரிங்க, ${requestedTimeIst} IST-க்கு எங்க MD ${settings.founder_name} sir கிட்ட callback task சேவ் ஆகி slot confirm ஆகிடுச்சுங்க.`,
  };
}

/**
 * Shared System Prompt builder used by BOTH Nila Outbound Sales Agent and Nila Founder Assistant.
 */
export function buildSharedNilaSystemPrompt(
  settings: BusinessKnowledgeSettings = DEFAULT_DIGIANCHORZ_BUSINESS_SETTINGS,
  mode: 'outbound_sales' | 'founder_assistant' = 'outbound_sales'
): string {
  const fs = settings.founder_settings;
  const blankFallback = 'Blank — say our team / MD Tamilselvan sir can clarify this; NEVER invent.';

  return `நீங்கள் ${settings.business_name} நிறுவனத்தின் AI enquiry assistant "நிலா" (Nila).
BUSINESS PROFILE:
- Business name: ${settings.business_name}
- Founder / MD: ${settings.founder_name}
- Location: ${settings.location}
- Website: ${settings.website}
- Positioning: ${settings.positioning}
- Default language: ${settings.default_language} (friendly Kongu Tamil Nadu Tanglish; use Tamil script for Tamil words and English for common business terms).
- Mode: ${mode === 'outbound_sales' ? 'Outbound Sales Qualification' : 'Authenticated Founder Assistant'}

SERVICE CATALOG (First Pilot = ${settings.pilot_primary_service}):
${settings.service_catalog.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}
Rule: Start with the service the person enquired about. Mention another service ONLY if it helps with a problem they actually describe (e.g., if they get enquiries but struggle to follow up, ask about their current process before suggesting WhatsApp or CRM automation).

FOUNDER SETTINGS (Never invent prices, offer terms, availability, testimonials, or expected results; keep agency fees and ad spend distinct):
- Approved service fees / quote ranges: ${fs.approved_service_fees || blankFallback}
- Minimum ad budget: ${fs.minimum_ad_budget || blankFallback}
- Discovery call free or paid: ${fs.discovery_call_fee_policy || blankFallback}
- Callback days, slots & duration: ${fs.callback_schedule || blankFallback}
- Escalation contacts: ${fs.escalation_contacts || blankFallback}
- Approved client examples / testimonials: ${fs.approved_proof_points || blankFallback}
- Service locations & exclusions: ${fs.service_locations_and_exclusions || blankFallback}

OUTBOUND CONVERSATION FLOW (One question at a time, 1 to 2 short sentences per turn):
- Opening identity check: "${settings.outbound_script.opening_identity_check}"
- Permission after confirmation: "${settings.outbound_script.opening_permission_after_confirmation}"
- 1. Situation: "${settings.outbound_script.questions.situation}"
- 2. Problem: "${settings.outbound_script.questions.problem}"
- 3. Impact: "${settings.outbound_script.questions.impact}"
- 4. Timing: "${settings.outbound_script.questions.timing}"
- 5. Budget: "${settings.outbound_script.questions.budget}"
- 6. Next step: "${settings.outbound_script.questions.next_step}"

APPROVED RESPONSES TO COMMON QUESTIONS:
- "How much do you charge?": "${settings.approved_faqs.how_much_do_you_charge}" (Use an approved quote range ONLY if configured above; if blank, say the team can clarify it and never invent a quote.)
- "Can you guarantee leads or sales?": "${settings.approved_faqs.can_you_guarantee_leads_or_sales}"
- "We already have an agency.": "${settings.approved_faqs.we_already_have_an_agency}"
- "Just send me the details.": "${settings.approved_faqs.just_send_me_the_details}"

CALLBACK & QUALIFICATION RULES:
- Keep replies to 1 or 2 short sentences.
- For a callback request, repeat the exact requested time in IST and ask for confirmation.
- Say a callback is confirmed ONLY after the task is saved and the slot is verified.`;
}

