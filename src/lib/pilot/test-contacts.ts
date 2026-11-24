export interface PilotTestContactSeed {
  rowNumber: number;
  externalLeadId: string;
  fullName: string;
  rawPhone: string;
  phoneE164: string;
  serviceInterest: string;
  source: string;
  callingEligibility: 'ELIGIBLE';
  eligibilityReference: string;
  doNotCall: false;
}

export const PILOT_TEST_CONTACTS: PilotTestContactSeed[] = [
  {
    rowNumber: 2,
    externalLeadId: 'NILA-TEST-001',
    fullName: 'Test Contact 1',
    rawPhone: '+916383939949',
    phoneE164: '+916383939949',
    serviceInterest: 'Meta Ads for Facebook and Instagram lead generation',
    source: 'Google Sheet (Pilot Test)',
    callingEligibility: 'ELIGIBLE',
    eligibilityReference: 'GSHEET-PILOT-ROW-2-ELIGIBLE',
    doNotCall: false,
  },
  {
    rowNumber: 3,
    externalLeadId: 'NILA-TEST-002',
    fullName: 'Test Contact 2',
    rawPhone: '+918754921159',
    phoneE164: '+918754921159',
    serviceInterest: 'Meta Ads for Facebook and Instagram lead generation',
    source: 'Google Sheet (Pilot Test)',
    callingEligibility: 'ELIGIBLE',
    eligibilityReference: 'GSHEET-PILOT-ROW-3-ELIGIBLE',
    doNotCall: false,
  },
  {
    rowNumber: 4,
    externalLeadId: 'NILA-TEST-003',
    fullName: 'Test Contact 3',
    rawPhone: '+919445581778',
    phoneE164: '+919445581778',
    serviceInterest: 'Meta Ads for Facebook and Instagram lead generation',
    source: 'Google Sheet (Pilot Test)',
    callingEligibility: 'ELIGIBLE',
    eligibilityReference: 'GSHEET-PILOT-ROW-4-ELIGIBLE',
    doNotCall: false,
  },
  {
    rowNumber: 5,
    externalLeadId: 'NILA-TEST-004',
    fullName: 'Test Contact 4',
    rawPhone: '+917708844146',
    phoneE164: '+917708844146',
    serviceInterest: 'Meta Ads for Facebook and Instagram lead generation',
    source: 'Google Sheet (Pilot Test)',
    callingEligibility: 'ELIGIBLE',
    eligibilityReference: 'GSHEET-PILOT-ROW-5-ELIGIBLE',
    doNotCall: false,
  },
  {
    rowNumber: 6,
    externalLeadId: 'NILA-TEST-005',
    fullName: 'Test Contact 5',
    rawPhone: '+919952823176',
    phoneE164: '+919952823176',
    serviceInterest: 'Meta Ads for Facebook and Instagram lead generation',
    source: 'Google Sheet (Pilot Test)',
    callingEligibility: 'ELIGIBLE',
    eligibilityReference: 'GSHEET-PILOT-ROW-6-ELIGIBLE',
    doNotCall: false,
  },
];

export const PILOT_ALLOWLIST_PHONES: string[] = PILOT_TEST_CONTACTS.map((c) => c.phoneE164);

export function isPilotTestContact(externalLeadId: string | null | undefined): boolean {
  if (!externalLeadId) return false;
  return externalLeadId.toUpperCase().startsWith('NILA-TEST-');
}
