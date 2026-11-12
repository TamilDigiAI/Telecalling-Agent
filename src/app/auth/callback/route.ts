import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';

function sanitizeRedirectPath(nextParam: string | null): string {
  if (!nextParam || !nextParam.startsWith('/') || nextParam.startsWith('//')) {
    return '/';
  }
  return nextParam;
}

/**
 * Exact Supabase Auth Callback Route: GET /auth/callback
 * Exchanges PKCE auth code or OTP token_hash for an authenticated @supabase/ssr session cookie.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const otpType = searchParams.get('type') as EmailOtpType | null;
  const nextPath = sanitizeRedirectPath(searchParams.get('next'));

  const supabase = await createServerSupabaseClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${nextPath}`);
    }
  } else if (tokenHash && otpType) {
    const { error } = await supabase.auth.verifyOtp({
      type: otpType,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(`${origin}${nextPath}`);
    }
  }

  const errorRedirect = new URL('/login', origin);
  errorRedirect.searchParams.set('error', 'auth_callback_failed');
  return NextResponse.redirect(errorRedirect);
}

