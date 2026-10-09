# Live Recruitment Pilot — first 50 organic WhatsApp applicants

## Scope authorized by the project owner

The project owner explicitly asked to begin the real pilot and chose to manage their own database backup. This feature does **not** create, verify, or restore a backup.

**Pilot type: live observational cohort**, not proactive recruitment outreach and not a strict rollout gate. The existing active office Agent continues replying normally to other incoming applicants. This pilot does not change the Office Agent setting, enable paid LLM services, modify any qualification rules, or send any extra WhatsApp messages.

The active destination at launch is the sole active WhatsApp account, **الرقم الرئيسي** (`ae4b98eb-583b-40c6-b811-3bc5e07dbc29`). No existing applicants were registered when the account was checked, so the cohort is restricted to **new inbound WhatsApp contacts** after the pilot starts.

### Behavior

- The admin can start/stop *pilot observation* in **AI Agent → الأداء والتجربة**.
- Each new inbound WhatsApp applicant is enrolled via one `masar_events` row, `agent_pilot_enrolled`, with applicant UUID and stable run/account IDs. There are **no extra outgoing messages**.
- Up to **50 distinct new applicants** join; subsequent applicants are excluded from the **tracking cohort**, not from the already-active bot.
- The monitoring group exposes only aggregate enrolled, remaining, form-complete, and distinct staff intervention count. Raw message text, phone number, and applicant IDs never go to the browser.
- An authenticated **system admin** can start/stop only the audit cohort using `POST /api/agent/pilot/start` or `POST /api/agent/pilot/stop`. Both operations write one audit event and never change office agent settings.
- **Stopping pilot observation does not stop the bot.** To pause the bot itself, use the separate existing Office Agent control. This distinction is clearly labeled in the dashboard.

### Guardrails

1. **No campaign or mass messages.** Only contacts that initiate WhatsApp conversation themselves are eligible; existing user outreach/follow-up logic is unchanged.
2. **No automatic candidate acceptance or rejection.** Qualification rules and `preferred_work_area` are unchanged.
3. **No paid LLM provider auto-enable**, no extra remote calls.
4. **No DB schema migration**, and the pilot activity is an additive metadata-only event audit. No data deletion or mass updates.
5. The cohort is processed in the same single worker spool as normal WhatsApp ingestion. If multiple worker instances run in parallel, event-only counting may not enforce a hard transactional limit; production should operate a single ingestion worker until an atomic enrollment constraint is available.
6. **Current source backup** remains available from earlier, but database+Storage backup is owner-managed. The admin should separately perform that process.

### Testing and verification

Run `npm test` and `npm run build`. `pilot-observation.test.js` tests account isolation, duplicate prevention, the 50-person cap, status transitions and avoidance of PII in reports. After Railway deploy success, start the monitoring for the main number and verify `AI Agent → الأداء والتجربة` shows active. The first real inbound contact will create the first enrollment event and the dashboard may update after refresh.

### After pilot

Review agent turns and human handoffs from the Quality Center and the live pilot summary. Seek confirmation before adding unsolicited contact, expanding to a second office or changing the Agent live/assist settings.
