import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createSupabaseAdminClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { getPublicSupabaseConfig, getRuntimeEnv } from '@/lib/env';

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getPublicSupabaseConfig();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where response cookies cannot be mutated directly;
          // middleware refreshes the session cookie on the request/response boundary.
        }
      },
    },
  });
}

/**
 * Server-only Supabase client using SUPABASE_SECRET_KEY.
 * Used strictly for background job execution (sheet_sync_jobs) and founder bootstrap.
 */
export function createServiceRoleSupabaseClient() {
  const env = getRuntimeEnv();
  if (!env.supabaseSecretKey) {
    throw new Error(
      'SUPABASE_SECRET_KEY is required for server-side admin/worker operations.'
    );
  }

  return createSupabaseAdminClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

