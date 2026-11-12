import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_GOOGLE_SHEET_ID,
  DEFAULT_GOOGLE_SHEET_URL,
  DEFAULT_VOICE_AGENT_NAME,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
} from '../src/lib/env';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BootstrapFounderResult {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  agent_name: string;
  google_sheet_id: string;
  member_id: string;
  owner_user_id: string;
  owner_email: string;
  synthetic_lead_id: string;
  synthetic_external_lead_id: string;
}

export function parseBootstrapArgs(argv: string[]): { userId: string; email: string } {
  const args = argv.slice(2);
  let userId = process.env.FOUNDER_USER_ID?.trim() || '';
  let email = process.env.FOUNDER_LOGIN_EMAIL?.trim() || 'founder@digianchorz.com';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--user-id' && args[i + 1]) {
      userId = args[++i].trim();
    } else if (arg.startsWith('--user-id=')) {
      userId = arg.split('=')[1].trim();
    } else if (arg === '--email' && args[i + 1]) {
      email = args[++i].trim();
    } else if (arg.startsWith('--email=')) {
      email = arg.split('=')[1].trim();
    } else if (!arg.startsWith('-') && !userId) {
      userId = arg.trim();
    } else if (!arg.startsWith('-') && userId && email === 'founder@digianchorz.com') {
      email = arg.trim();
    }
  }

  if (!userId || !UUID_REGEX.test(userId)) {
    throw new Error(
      'Usage: npm run bootstrap:founder -- <SUPABASE_AUTH_USER_ID> [founder_email]\n' +
        'Example: npm run bootstrap:founder -- 11111111-1111-4111-8111-111111111111 founder@digianchorz.com'
    );
  }

  return { userId, email };
}

/**
 * Executes the founder bootstrap step against Supabase Postgres:
 * 1. Assigns the existing Supabase Auth user ID as `owner` of the DigiAnchorZ workspace.
 * 2. Configures Voice Agent "Nila" and Google Sheet 1X9sQhlRx_7jo1c6gZ8SBxNas5aqqRjgAY0-UzOUB97A.
 * 3. Inserts/upserts the synthetic test lead (DAZ-SYNTH-LEAD-001).
 */
export async function bootstrapFounderWithClient(
  adminClient: SupabaseClient,
  userId: string,
  email = 'founder@digianchorz.com'
): Promise<BootstrapFounderResult> {
  const { data, error } = await adminClient.rpc('bootstrap_digianchorz_founder', {
    p_user_id: userId,
    p_email: email,
  });

  if (!error && data) {
    return data as BootstrapFounderResult;
  }

  // Fallback direct table upsert if RPC is not yet loaded
  const { data: ws, error: wsErr } = await adminClient
    .from('workspaces')
    .upsert(
      {
        slug: DEFAULT_WORKSPACE_SLUG,
        name: DEFAULT_WORKSPACE_NAME,
        timezone: 'Asia/Kolkata',
        agent_name: DEFAULT_VOICE_AGENT_NAME,
        app_mode: 'mock',
        telephony_mode: 'mock',
        google_sheet_id: DEFAULT_GOOGLE_SHEET_ID,
        google_sheet_url: DEFAULT_GOOGLE_SHEET_URL,
        google_sheet_tab: 'Leads',
      },
      { onConflict: 'slug' }
    )
    .select('id, slug, name, agent_name, google_sheet_id')
    .single();

  if (wsErr || !ws) {
    throw wsErr ?? new Error('Failed to upsert DigiAnchorZ workspace');
  }

  const { data: member, error: memErr } = await adminClient
    .from('workspace_members')
    .upsert(
      {
        workspace_id: ws.id,
        user_id: userId,
        email,
        role: 'owner',
      },
      { onConflict: 'workspace_id,user_id' }
    )
    .select('id')
    .single();

  if (memErr || !member) {
    throw memErr ?? new Error('Failed to assign founder as owner of DigiAnchorZ workspace');
  }

  const { data: lead, error: leadErr } = await adminClient
    .from('leads')
    .upsert(
      {
        workspace_id: ws.id,
        external_lead_id: 'DAZ-SYNTH-LEAD-001',
        sheet_id: DEFAULT_GOOGLE_SHEET_ID,
        sheet_tab: 'Leads',
        sheet_row_number: 2,
        full_name: 'Karthik Subramanian',
        raw_phone: '98765 43210',
        phone_e164: '+919876543210',
        service_interest: 'Meta Ads Enquiry Follow-up',
        source: 'Google Sheet',
        calling_eligibility: 'ELIGIBLE',
        eligibility_reference: 'GSHEET-1X9sQhlRx-ROW-2-ENQUIRY-CONSENT',
        available_window: '10:00-19:00 IST',
        do_not_call: false,
        lead_temperature: 'UNQUALIFIED',
        owner_user_id: userId,
        sync_status: 'PENDING',
      },
      { onConflict: 'workspace_id,external_lead_id' }
    )
    .select('id, external_lead_id')
    .single();

  if (leadErr || !lead) {
    throw leadErr ?? new Error('Failed to seed synthetic test lead');
  }

  return {
    workspace_id: ws.id,
    workspace_slug: ws.slug,
    workspace_name: ws.name,
    agent_name: ws.agent_name,
    google_sheet_id: ws.google_sheet_id,
    member_id: member.id,
    owner_user_id: userId,
    owner_email: email,
    synthetic_lead_id: lead.id,
    synthetic_external_lead_id: lead.external_lead_id,
  };
}

async function main() {
  const { userId, email } = parseBootstrapArgs(process.argv);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !secretKey || supabaseUrl.includes('your-project-ref')) {
    console.error(
      'Error: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in your environment (.env.local) before running bootstrap:founder.'
    );
    process.exit(1);
  }

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await bootstrapFounderWithClient(adminClient, userId, email);
  console.log('DigiAnchorZ Founder Bootstrap Complete:');
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('bootstrap-founder.ts') ||
    process.argv[1].endsWith('bootstrap-founder.js'));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

