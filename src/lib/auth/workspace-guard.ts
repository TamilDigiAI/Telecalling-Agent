import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  createLocalPilotSupabaseClient,
  PILOT_FOUNDER_COOKIE_NAME,
  verifyPilotFounderCookieValue,
} from '@/lib/supabase/local-pilot-fallback';
import { DEFAULT_WORKSPACE_SLUG, getRuntimeEnv } from '@/lib/env';
import type { Workspace, WorkspaceMember } from '@/types/crm';

export class WorkspaceAccessDeniedError extends Error {
  public readonly statusCode: number;

  constructor(message = 'Access denied: you are not a member of this workspace.', statusCode = 403) {
    super(message);
    this.name = 'WorkspaceAccessDeniedError';
    this.statusCode = statusCode;
  }
}

export interface AuthenticatedWorkspaceContext {
  supabase: SupabaseClient;
  user: User;
  workspace: Workspace;
  membership: WorkspaceMember;
}

/**
 * Verifies the user is authenticated via Supabase Auth and is an active member
 * of the requested workspace (defaults to 'digianchorz').
 */
export async function verifyWorkspaceMembership(
  supabase: SupabaseClient,
  workspaceSlugOrId: string = DEFAULT_WORKSPACE_SLUG
): Promise<AuthenticatedWorkspaceContext> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new WorkspaceAccessDeniedError('Authentication required.', 401);
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      workspaceSlugOrId
    );

  const workspaceQuery = supabase.from('workspaces').select('*');
  const { data: workspace, error: wsError } = await (isUuid
    ? workspaceQuery.eq('id', workspaceSlugOrId).maybeSingle()
    : workspaceQuery.eq('slug', workspaceSlugOrId).maybeSingle());

  if (wsError || !workspace) {
    throw new WorkspaceAccessDeniedError(
      `Access denied: user ${user.id} is not a member of workspace "${workspaceSlugOrId}" or workspace does not exist.`,
      403
    );
  }

  const { data: membership, error: memberError } = await supabase
    .from('workspace_members')
    .select('*')
    .eq('workspace_id', workspace.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (memberError || !membership) {
    throw new WorkspaceAccessDeniedError(
      `Access denied: user ${user.id} is not a member of workspace "${workspace.slug}".`,
      403
    );
  }

  return {
    supabase,
    user,
    workspace: workspace as Workspace,
    membership: membership as WorkspaceMember,
  };
}

/**
 * Guard for Server Actions: throws WorkspaceAccessDeniedError if unauthenticated
 * or outside the workspace.
 */
export async function requireWorkspaceActionContext(
  workspaceSlugOrId: string = DEFAULT_WORKSPACE_SLUG
): Promise<AuthenticatedWorkspaceContext> {
  const cookieStore = await cookies();
  const pilotUser = verifyPilotFounderCookieValue(
    cookieStore.get(PILOT_FOUNDER_COOKIE_NAME)?.value
  );
  if (pilotUser) {
    const localClient = createLocalPilotSupabaseClient(pilotUser);
    return verifyWorkspaceMembership(localClient, workspaceSlugOrId);
  }

  const env = getRuntimeEnv();
  if (!env.isSupabaseConfigured) {
    throw new WorkspaceAccessDeniedError(
      'Supabase environment variables are not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.',
      500
    );
  }
  const supabase = await createServerSupabaseClient();
  return verifyWorkspaceMembership(supabase, workspaceSlugOrId);
}

/**
 * Guard for CRM Server Components / Routes: redirects to /login if unauthenticated,
 * or returns workspace context (or membership status so the UI can show bootstrap instructions).
 */
export async function getProtectedPageContext(
  workspaceSlugOrId: string = DEFAULT_WORKSPACE_SLUG
): Promise<
  | { status: 'ready'; context: AuthenticatedWorkspaceContext }
  | { status: 'unbootstrapped'; user: User }
> {
  const cookieStore = await cookies();
  const pilotUser = verifyPilotFounderCookieValue(
    cookieStore.get(PILOT_FOUNDER_COOKIE_NAME)?.value
  );
  if (pilotUser) {
    const localClient = createLocalPilotSupabaseClient(pilotUser);
    const context = await verifyWorkspaceMembership(localClient, workspaceSlugOrId);
    return { status: 'ready', context };
  }

  const env = getRuntimeEnv();
  if (!env.isSupabaseConfigured) {
    redirect('/login?setup=required');
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  try {
    const context = await verifyWorkspaceMembership(supabase, workspaceSlugOrId);
    return { status: 'ready', context };
  } catch {
    return { status: 'unbootstrapped', user };
  }
}

