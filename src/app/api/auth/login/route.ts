import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  createPilotFounderCookieValue,
  PILOT_FOUNDER_COOKIE_NAME,
} from '@/lib/supabase/local-pilot-fallback';

function getRequestOrigin(request: NextRequest): string {
  const originHeader = request.headers.get('origin');
  if (originHeader && originHeader.startsWith('http') && !originHeader.includes('0.0.0.0')) {
    return originHeader.replace(/\/+$/, '');
  }
  const refererHeader = request.headers.get('referer');
  if (refererHeader && refererHeader.startsWith('http') && !refererHeader.includes('0.0.0.0')) {
    try {
      return new URL(refererHeader).origin;
    } catch {
      // fall through
    }
  }
  const host =
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    'localhost:3000';
  const proto =
    request.headers.get('x-forwarded-proto') ||
    (host.endsWith('.lhr.life') || host.endsWith('.vercel.app') ? 'https' : 'http');
  const safeHost = host.startsWith('0.0.0.0')
    ? host.replace('0.0.0.0', 'localhost')
    : host;
  return `${proto}://${safeHost}`;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = String(formData.get('email') ?? 'pheonixtamil2025@gmail.com').trim();
  const password = String(formData.get('password') ?? '').trim();
  const nextRaw = String(formData.get('next') ?? '/').trim();
  const nextPath = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/';

  const origin = getRequestOrigin(request);

  if (!email || !password) {
    return NextResponse.redirect(new URL('/login?error=missing_credentials', origin), 303);
  }

  // 1. Check direct founder password login ("Tamil@2909" or "Tamil@29090602")
  if (password === 'Tamil@2909' || password === 'Tamil@29090602') {
    const response = NextResponse.redirect(new URL(nextPath, origin), 303);
    response.cookies.set(
      PILOT_FOUNDER_COOKIE_NAME,
      createPilotFounderCookieValue(email),
      {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      }
    );
    return response;
  }

  // 2. Otherwise authenticate against Supabase Auth
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(error.message)}`, origin),
        303
      );
    }
    return NextResponse.redirect(new URL(nextPath, origin), 303);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sign-in failed';
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(message)}`, origin),
      303
    );
  }
}

