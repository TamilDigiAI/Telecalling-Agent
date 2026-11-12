# DigiAnchorZ Voice · Setup checklist

**Build assumption**  
“Google leads” means leads already landing in a Google Sheet. If they come directly from a Google Ads lead form, first configure an intake integration such as the official webhook, validate its Google key and map the submitted lead fields into the same intake schema. The v1 Founder CRM is the built-in app. If there is an existing CRM to update, collect its vendor name, API base URL, authentication method, record ID field and status mapping before building a second connector.

## Before opening Antigravity

1. **Create a private Git repository and open its folder in Antigravity.** Install Git and a supported Node.js LTS locally. Put the supplied `public/brand/` folder at the project root. Paste `MASTER-PROMPT.md` from below the rule. Run the mock app using synthetic data.
2. **Prepare one test Google Sheet.** Duplicate your current lead sheet, keep the same header layout, set phones to plain text, and add the automation columns below. In Google Cloud, enable the Sheets API. Share the test Sheet as Editor with the runtime service account's email. Restrict the service account to the required Sheet. On Google Cloud, use the attached runtime service account and Application Default Credentials with a Sheets-capable access token. For local live testing use approved service account impersonation or a securely mounted key only if your organization permits it.
3. **Create a Supabase project.** Collect the project URL and publishable key, invite the founder through Supabase Auth, and get the connection string for migrations and the worker where needed. Add the deployed login redirect URLs. Decide which users can manage workspace settings and approve calls.
4. **Open an Exotel India account.** Complete provider onboarding and get an approved caller ID, AgentStream activation and the permitted route for automated follow-up of enquiry leads. Confirm whether direct Connect Voice AI is accepted or a configured flow is required. Verify the sender registration, declaration, consent/preferences, permitted call window and number series that apply with Exotel or the originating access provider before calling real leads. The TRAI regulations and amendments are linked below. Start with staff test numbers that have agreed to receive the calls.
5. **Open a Sarvam account and select a text LLM.** Generate a Sarvam API key and choose a Tamil-capable STT/TTS setup and voice. Get a separate text LLM key and model ID if using a separate provider. Test real Tamil-English phone audio with Karur-area speakers. Judge service names, names and numbers, interruptions and whether callback times were correctly captured.
6. **Prepare deployment for the live pilot.** Choose a Google Cloud project with billing for the Cloud Run voice service and scheduled dispatch. Configure public HTTPS and WSS endpoints for provider traffic, service identity for Sheet access, scheduler identity for dispatch, request timeouts and secret storage. Production settings should include call limits and the approved calling window. Turn on the staff-number allowlist before placing real test calls.

## Configuration and credentials

Use the names below as suggested project variables. Enter secret values in the deployment secret manager or an ignored local env file. The Antigravity prompt and the committed env example receive placeholder names only.

| Integration | IDs and settings | Secret or access to provision |
|---|---|---|
| Google Sheets | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB`, header mapping and runtime service account email | Share the Sheet as Editor with the service account. Use the attached Cloud Run service account via ADC. A securely mounted credential is a local fallback when permitted. |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, founder login email, Auth redirect URLs | `DATABASE_URL` for workers/migrations as applicable. Use `SUPABASE_SECRET_KEY` only for server admin operations that require it. |
| Exotel | `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_BASE_URL`, `EXOTEL_CALLER_ID`, approved call mode and flow identifier if used | `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, app-generated callback/stream token signing secret as required by the integration design. |
| Sarvam speech | `SARVAM_STT_MODEL`, `SARVAM_TTS_MODEL`, `SARVAM_TTS_SPEAKER`, tested language and audio settings | `SARVAM_API_KEY`. |
| Dialogue model | `LLM_PROVIDER`, `LLM_MODEL` | `LLM_API_KEY` if required by the provider. |
| Hosting | `APP_BASE_URL`, `VOICE_PUBLIC_BASE_URL`, `APP_TIMEZONE=Asia/Kolkata`, scheduler service account and audience | Server secret storage and authorized scheduler identity. |
| Pilot | `APP_MODE=mock` initially, test contacts, attempt cap, cooldown, permitted hours and workspace pause switch | Load actual test numbers into the access-controlled workspace settings. Switch to pilot only after the setup checks pass. |
| Google Ads intake, if needed | Google Ads lead form and its intake endpoint | Google lead form webhook key stored on the server and validated on receipt. |

The public Supabase key is for client use with Auth and row-level security. A Supabase secret key and database connection string are server-only. An existing external CRM may also require its API key or OAuth credentials.

## Lead sheet mapping

**Intake fields**  
`Lead ID` · `Name` · `Phone` · `Service` · `Source` · `Created At` · `Calling Eligibility` · `Eligibility Reference` · `Do Not Call`

**Automation fields**  
`CRM Lead ID` · `Call Outcome` · `Lead Temperature` · `Qualification Reason` · `Call Summary` · `Last Call At` · `Callback At` · `Attempts` · `Sync Status` · `Last Synced At` · `Automation Do Not Call`

Keep the original intake fields intact during write-back. Supply an eligibility reference that can be audited. A yes/no cell without a supporting source record cannot establish the right to call.

## Business inputs the founder supplies

- Services to qualify and the priority order. Start with one offer, such as Meta Ads enquiry follow-up.
- Company description, service locations, offer terms, what prices the agent can quote, approved claims, FAQs, and common objections.
- What makes an enquiry a fit, minimum budget if used, how to handle pricing questions, and examples of hot, warm and cold leads.
- Founder login email, follow-up owner, callback slots, office hours, escalation process and the exact contact list for the pilot.
- Enquiry form wording and evidence fields, approved intro, call route, opt-out process, and retention choices. Keep recordings off for the initial pilot.
- Preferred agent voice and a Tanglish pronunciation list for DigiAnchorZ, Karur, Meta Ads, SEO and customer names.

## First pilot acceptance

Run three controlled journeys before opening the queue to customer leads.

1. An eligible test lead agrees to a specific founder callback. Confirm the task, CRM result and same Sheet row all show the same date and time.
2. A test call goes unanswered and a second test contact opts out. Confirm the unanswered record remains unqualified and the opt-out suppresses future calls.
3. Make Sheet write-back temporarily fail after a completed test call. Confirm the CRM retains the result, a retry updates the right Sheet row, and the phone never rings a second time.

Then have the founder ask “Innaiku hot leads yaaru?” and create a follow-up by voice. Confirm that the assistant reads live CRM data, asks for confirmation, and creates exactly one task.

## Official references

- [Google Antigravity settings](https://antigravity.google/docs/settings?tab=ide)
- [Google Workspace access credentials](https://developers.google.com/workspace/guides/create-credentials)
- [Google Sheets row metadata](https://developers.google.com/workspace/sheets/api/guides/metadata)
- [Google Ads lead form webhook](https://developers.google.com/google-ads/webhook/docs/implementation)
- [Exotel Connect Voice AI](https://developer.exotel.com/docs/agentstream/connect-voice-ai)
- [Exotel Connect with Flow](https://developer.exotel.com/docs/agentstream/connect-voice-ai-flow)
- [TRAI TCCCPR regulations and amendments](https://www.trai.gov.in/release-publication/regulations/amendments-page/7617)
- [Sarvam realtime speech recognition](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)
- [Sarvam streaming TTS](https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)
