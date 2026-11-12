import fs from 'node:fs';
import path from 'node:path';

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

async function callViaExotelTrial(targetPhone: string) {
  loadEnvLocal();
  const accountSid = process.env.EXOTEL_ACCOUNT_SID?.trim() || 'digianchorz1';
  const apiKey = process.env.EXOTEL_API_KEY?.trim() || '';
  const apiToken = process.env.EXOTEL_API_TOKEN?.trim() || '';
  const callerId = process.env.EXOTEL_CALLER_ID?.trim() || '09513886363';
  const appId = process.env.EXOTEL_APP_ID?.trim() || '1370873';
  const voicebotAppId = process.env.EXOTEL_VOICEBOT_APP_ID?.trim() || '1383045';

  const basicAuth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
  const baseUrls = ['https://api.exotel.com', 'https://api.in.exotel.com'];

  for (const baseUrl of baseUrls) {
    // First check account metadata or call connect
    for (const candidateAppId of [appId, voicebotAppId]) {
      const form = new URLSearchParams();
      form.set('From', targetPhone);
      form.set('CallerId', callerId);
      form.set('Url', `http://my.exotel.com/${accountSid}/exoml/start_voice/${candidateAppId}`);
      form.set('CallType', 'trans');

      console.log(
        `Dialing ${targetPhone} via ${baseUrl} Account=${accountSid}, CallerId=${callerId}, AppId=${candidateAppId}...`
      );

      const res = await fetch(`${baseUrl}/v1/Accounts/${accountSid}/Calls/connect.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });

      const text = await res.text();
      console.log(`${baseUrl} HTTP ${res.status} (App ${candidateAppId}):`);
      console.log(text);
      if (res.ok) return;
    }
  }
}

callViaExotelTrial('06383939949').catch((err) => {
  console.error(err);
  process.exit(1);
});
