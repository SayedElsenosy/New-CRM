# Phase 6 — Recruitment Performance & Pilot (pre-release)

## Delivery status and the hard backup gate

**Source snapshot taken first**:
- GitHub branch: backup/pre-recruitment-pilot-phase6-2026-10-09
- Pinned commit: e1bf7996dd1f3ad81cfcc201a671124021cffcf6
- [View backup](https://github.com/SayedElsenosy/New-CRM/tree/backup/pre-recruitment-pilot-phase6-2026-10-09)

**Production DB / Storage backup is NOT complete or verified.** Supabase project: Recruitment-System (ref oflepwasoawmuspxgnal, Free plan). The connected Supabase commands can read schema/query metadata but do not provide backup creation/download/restoration for both Postgres and actual Storage files. The user explicitly chose to defer the full backup; deploying the **read-only dashboard** is allowed because this phase changes no schema or applicant data. Do NOT activate a real pilot, perform bulk transcript mining, or alter production data structures until the independent backup and recovery test below are verified.

Supabase documentation states Free projects should manually export database data, and DB backups **do not include actual Storage objects**:
- [Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Backup and Restore using CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase db dump](https://supabase.com/docs/reference/cli/supabase-db-dump)

### 1. Authorized admin: create independent database copy

1. On your own trusted machine (not in this chat), install Supabase CLI and Docker. Open [Project Connect](https://supabase.com/dashboard/project/oflepwasoawmuspxgnal?showConnect=true) to obtain the actual session-pooler connection string and supply the password securely.
2. Create a private backup directory **outside the repository** with restricted permissions and enough free disk space. Do not commit SQL dumps or credentials to GitHub or send them in chat.
3. Execute these documented commands with the real connection URL in your own terminal:

\`\`\`bash
supabase db dump --db-url "$SUPABASE_DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$SUPABASE_DB_URL" -f schema.sql
supabase db dump --db-url "$SUPABASE_DB_URL" -f data.sql --use-copy --data-only
\`\`\`

4. Confirm the files exist, are nonempty and encrypted at rest. Restore the dump into a **separate, isolated test environment**, following Supabase's documented process, and check the main table counts/foreign-key consistency. **Never run a restore command against production to test it.**

The Supabase CLI excludes certain managed schemas (including auth and storage) by default: examine your application's Auth and Storage dependencies and the Supabase migration guide before declaring this an exhaustive data copy.

### 2. Storage/media is a separate mandatory backup

Inventory the Storage buckets and actual object files. Export **all actual objects** using an authorized Storage API/client or secure bulk-export tool, without uploading them to ChatGPT or GitHub. Store a private inventory (bucket, object key, size, checksum), and restore a sample to a separate Storage environment. Verify that media referenced in \`masar_messages.media_path\` is present.

A database dump containing \`storage.objects\` metadata is **not** a copy of the underlying stored files. Likewise Railway's WhatsApp session volume needs its own documented backup if the organization requires a full disaster recovery snapshot.

### 3. Backup acceptance proof (do not share secrets or data)

An authorized administrator should record **only non-sensitive proof**:
- backup timestamp and encrypted off-site storage location (no password)
- database schema+roles+data files copied, valid and restored to isolated Postgres
- Storage buckets+objects copied with object counts/checksums and sample restore verified
- recovery point and expected retention, plus who tested it

Nothing in this phase marks these steps verified automatically. The dashboard intentionally shows them as **not verified** until a later approved rollout change.

## Backend implementation

\`GET /api/agent/performance?days=1|7|30\` is admin-only and **read-only**:
- queries metadata from \`masar_applicants\` (\`id,stage,created_at,last_message_at\`), \`masar_messages\` (\`applicant_id,created_at,direction,sender\`) and \`masar_agent_decisions\` (\`applicant_id,created_at,latency_ms\`)
- never reads \`masar_messages.body\`, candidate name/phone/notes, IDs for display, or raw private transcripts
- returns aggregate cohort funnel only; applicant identifiers remain transient in the API process and are not returned
- selected-day **cohort** means applicants created in the window; stage reflects **current form state**, not acceptance/hiring and not stage as of creation time
- reports registrations, form-completed, engaged, 24h inactive among incomplete, inbound/bot message volume and median measured planner latency
- completion duration and human-reviewed response accuracy return null (unavailable) instead of made-up numbers
- caps each source at 1,000 metadata rows and suppresses denominator-based rates when data is truncated; includes a visible partial-sample warning

UI: **AI Agent → الأداء والتجربة**, responsive on desktop/mobile, includes cohort cards, stage funnel, daily registration view, messages, explanations and launch readiness.

## Pilot control (deliberately disabled)

The UI shows **proposal only**, NOT a button that can turn the bot on for 50–100 people. \`pilot_active:false\` and \`status:'blocked'\` always.

Before any real controlled rollout:
1. Verified independent database **and** Storage backups + restore test.
2. At least the existing 560 synthetic QA cases passing on the candidate release.
3. Human review of sample outputs and staff handoff rules.
4. Define pilot candidate selection with opt-in/approved WhatsApp contact channels and staff capacity; choose up to 50–100 to start.
5. Get explicit authorization for the cohort activation and agreed rollback thresholds, and have an immediate switch back to stable deterministic flow.
6. Monitor completion, response quality reviewed by staff, handoff volume, tool failures, and errors daily; expand only after an explicit go/no-go.

Changing applicant qualification/eligibility or contacting real applicants is NOT part of this PR.

## Verification

\`\`\`bash
npm test
npm run build
\`\`\`

\`whatsapp-bot/test/recruitment-performance.test.js\` covers cohort scope, correct data denominators, 24h inactivity, missing-data handling, partial samples and forbidden automatic rollout. No test uses a real applicant or sends an actual WhatsApp message.

## Future improvements after backup

- Store explicit **form-completed-at** timestamp (with migration approved after backup) to measure actual median completion duration.
- Add human review verdict events and permission checks (after explicit approval) to calculate verified accuracy.
- Implement explicitly selected pilot group and rollout/rollback controls with staff signoff.
- Replace bounded samples with privacy-safe SQL/RPC aggregates once DB backup + migration approval are in place.
