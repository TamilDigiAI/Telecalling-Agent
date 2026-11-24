# DigiAnchorZ Voice — Docker Deployment & Rollback Guide

## 1. Prerequisites on the Linux Server

1. Point DNS `A` records to your server's public IPv4 address:
   - `crm.digianchorz.com` → `<SERVER_PUBLIC_IP>`
   - `voice.digianchorz.com` → `<SERVER_PUBLIC_IP>`
2. Create `.env.production` from `.env.example` (never commit `.env.production` to Git) and set:
   - `APP_BASE_URL=https://crm.digianchorz.com`
   - `VOICE_PUBLIC_BASE_URL=https://voice.digianchorz.com`
   - `SUPABASE_AUTH_REDIRECT_URL=https://crm.digianchorz.com/auth/callback`
   - `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_PHONE_NUMBER`, `VOBIZ_API_BASE_URL=https://api.vobiz.ai`
   - `SARVAM_API_KEY`, `SARVAM_STT_MODEL=saaras:v4`, `SARVAM_STT_MODE=codemix`, `SARVAM_TTS_MODEL=bulbul:v3`, `SARVAM_TTS_SPEAKER=ritu`, `SARVAM_TTS_LANGUAGE=ta-IN`, `LLM_MODEL=sarvam-105b-conversations`
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
   - `N8N_BASE_URL`, `N8N_WEBHOOK_SECRET`, `VOICE_INTERNAL_SHARED_SECRET`, `VOICE_CALLBACK_SIGNING_SECRET`
3. Update Supabase Auth **Redirect URLs** to include `https://crm.digianchorz.com/auth/callback`.
4. Apply database migration `supabase/migrations/20261124000600_vobiz_queue_and_integration_health.sql` to Supabase Postgres.

## 2. Deploy with Docker Compose

```bash
# Record current commit before deploying (for rollback)
git rev-parse HEAD > .last_deployed_commit

# Build & start CRM, Nila Voice, and Caddy HTTPS proxy
CRM_DOMAIN=crm.digianchorz.com VOICE_DOMAIN=voice.digianchorz.com \
  docker compose up -d --build

# Verify health
docker compose ps
curl -fsS https://crm.digianchorz.com/api/health
curl -fsS https://voice.digianchorz.com/health
```

## 3. Configure Vobiz Voice Application URLs

- **Answer URL:** `https://voice.digianchorz.com/vobiz/answer`
- **Hangup URL:** `https://voice.digianchorz.com/vobiz/hangup`
- **Status URL:** `https://voice.digianchorz.com/vobiz/status`
- **Stream Status URL:** `https://voice.digianchorz.com/vobiz/stream-status`
- **Bidirectional WSS:** `wss://voice.digianchorz.com/vobiz/stream`

## 4. Redeploy & Rollback

```bash
# Redeploy latest main
git fetch origin main && git checkout main && git pull --ff-only
docker compose up -d --build

# Rollback to previous commit
git checkout "$(cat .last_deployed_commit)"
docker compose up -d --build
```
