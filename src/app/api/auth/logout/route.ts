import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PILOT_FOUNDER_COOKIE_NAME } from '@/lib/supabase/local-pilot-fallback';

function getRequestOrigin(request: NextRequest): string {
  const host =
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    'localhost:3000';
  const proto = request.headers.get('x-forwarded-proto') || 'http';
  const safeHost = host.startsWith('0.0.0.0')
    ? host.replace('0.0.0.0', 'localhost')
    : host;
  return `${proto}://${safeHost}`;
}

export async function POST(request: NextRequest) {
  const origin = getRequestOrigin(request);
  try {
    const supabase = await createServerSupabaseClient();
    await supabase.auth.signOut();
  } catch {
    // Ignore if Supabase session is not active
  }

  const response = NextResponse.redirect(new URL('/login', origin), 303);
  response.cookies.delete(PILOT_FOUNDER_COOKIE_NAME);
  return response;
}

