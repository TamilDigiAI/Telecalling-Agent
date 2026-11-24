import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';

function normalizeIndianMobileToE164(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0') && /^0[6-9]\d{9}$/.test(digits)) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) {
    return `+${digits}`;
  }
  return null;
}

/**
 * POST /api/webhooks/n8n/exotel-dial
 * Dedicated n8n node endpoint where Nila picks the configured Exotel ExoPhone (09513886363)
 * and initiates an outbound call to the qualified lead's mobile number.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rawPhone = String(
      body.Phone ?? body.phone ?? body.phoneE164 ?? body.mobile ?? ''
    ).trim();
    const phoneE164 = normalizeIndianMobileToE164(rawPhone);

    if (!phoneE164) {
      return NextResponse.json(
        { error: `Invalid lead mobile number: "${rawPhone}"` },
        { status: 400 }
      );
    }

    const exotelSid =
      String(body.exotelAccountSid ?? '').trim() ||
      process.env.EXOTEL_ACCOUNT_SID?.trim() ||
      'digianchorz1';
    const exotelCallerId =
      String(body.exotelCallerId ?? '').trim() ||
      process.env.EXOTEL_CALLER_ID?.trim() ||
      '09513886363';
    const exotelAppId =
      String(body.exotelAppId ?? '').trim() ||
      process.env.EXOTEL_APP_ID?.trim() ||
      '1370873';
    const exotelKey = process.env.EXOTEL_API_KEY?.trim() || '';
    const exotelToken = process.env.EXOTEL_API_TOKEN?.trim() || '';
    const exotelBaseUrl = (
      process.env.EXOTEL_API_BASE_URL?.trim() || 'https://api.exotel.com'
    ).replace(/\/+$/, '');

    const nationalNumber = phoneE164.replace(/^\+91/, '0');
    const isFollowUpRetry = Boolean(body.isFollowUpRetry);
    const attemptNumber = Number(body.attemptNumber ?? body.Attempts ?? 1);

    let pstnStatus: 'dialed' | 'error' | 'mock_only' = 'mock_only';
    let pstnDetail = '';
    let providerCallSid: string | null = null;

    if (exotelSid && exotelKey && exotelToken && !exotelKey.includes('your_exotel')) {
      try {
        const basicAuth = Buffer.from(`${exotelKey}:${exotelToken}`).toString('base64');
        const form = new URLSearchParams();
        form.set('From', nationalNumber);
        form.set('CallerId', exotelCallerId);
        form.set('Url', `http://my.exotel.com/${exotelSid}/exoml/start_voice/${exotelAppId}`);
        form.set('CallType', 'trans');
        form.set(
          'CustomField',
          `agent=Nila&isFollowUp=${isFollowUpRetry}&attempt=${attemptNumber}`
        );

        const exoRes = await fetch(
          `${exotelBaseUrl}/v1/Accounts/${exotelSid}/Calls/connect.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form.toString(),
          }
        );

        const exoJson = (await exoRes.json().catch(() => ({}))) as {
          Call?: { Sid?: string };
          RestException?: { Message?: string };
        };

        if (exoRes.ok && exoJson.Call?.Sid) {
          pstnStatus = 'dialed';
          providerCallSid = exoJson.Call.Sid;
          pstnDetail = `Exotel ExoPhone ${exotelCallerId} dialed ${phoneE164} (CallSid: ${exoJson.Call.Sid}).`;
        } else {
          pstnStatus = 'error';
          pstnDetail =
            exoJson.RestException?.Message ||
            `Exotel HTTP ${exoRes.status} on ExoPhone ${exotelCallerId}. Proceeding with Nila voice qualification.`;
        }
      } catch (err) {
        pstnStatus = 'error';
        pstnDetail = err instanceof Error ? err.message : 'Exotel connect error';
      }
    }

    return NextResponse.json({
      ...body,
      ok: true,
      Phone: phoneE164,
      phoneE164,
      nationalNumber,
      exotelPicked: {
        agentName: 'Nila',
        exotelAccountSid: exotelSid,
        exotelCallerId,
        exotelAppId,
        pstnStatus,
        pstnDetail,
        providerCallSid,
        isFollowUpRetry,
        attemptNumber,
        dialedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Exotel dial step failed' },
      { status: 500 }
    );
  }
}

