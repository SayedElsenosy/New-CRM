# Phase 5 — Real Conversation Intelligence (Privacy-First)

## Backup established before starting

Backup branch: `backup/pre-conversation-intelligence-2026-10-09`
Exact pre-change main SHA: `6af730b8d8d0b080f11a27f7f8e4fce4ecfcbefb`.

This is an immutable-commit **source backup** and does not include a backup of production Supabase tables, media files or WhatsApp messages. No SQL migrations, production table alterations or data exports were performed in this phase. A separate verified Supabase database/storage backup is required **before any future bulk transcript extraction, raw-data training, or data rewrite**. The current feature intentionally does not do these.

## What was implemented

### 1. Metadata-only live conversation quality analysis

`whatsapp-bot/src/conversation-intelligence.js` builds bounded, preapproved signal categories from the current question, action, tool results, bot reply and LLM availability.

The only field saved to new `agent_turn` event detail is `quality_signals: ['ambiguous_reply', ...]`. It does not store additional transcript or personal identifiers. Supported signals:

- `ambiguous_reply`: bot repeats/clarifies a pending question without progress.
- `knowledge_gap`: bot lacks an office-verified fact.
- `tool_failure`: a read-only CRM tool returned `ok:false`.
- `llm_fallback`: planner fell back from an enabled LLM.
- `handoff`: staff intervention.
- `correction`: user explicitly corrects a previous fact.
- `multiple_intents`: compound question requiring 2+ CRM tools.
- `domain_guidance`: answer sourced from general expert guidance.
- `repeated_stall`: aggregate-only alert when consecutive ambiguous turns for the **same pending question and applicant** occur. IDs are used only inside the backend aggregator, never returned to dashboard.

`GET /agent/quality/metrics?days=1|7|30` provides `conversation` with aggregate counts, risk-category suggestions, daily trends and a clear disclaimer that these are **heuristics**, not verified factual errors or an objective accuracy percentage.

**AI Agent → مركز الجودة → ذكاء المحادثات الفعلية** shows this diagnostic overview with a link to the knowledge-review queue. This is observational; no automatic stage, qualification or bot mode changes.

### 2. Human-reviewed staff learning (fix of prior behavior)

Previously, the system could automatically approve/publish staff replies via `learnFromConversation`, `promotePendingLearning`, and `intelligenceState`/worker startup.

Now:
- A staff reply can generate an **office-scoped pending suggestion** via existing `masar_learning_suggestions`, never a published CRM fact.
- Explicit `AI Agent → المعرفة → اعتماد بعد المراجعة` is required to add knowledge, and **رفض** removes it from the active queue.
- Approval route validates the text with `safeLearningProposal` for direct personal contacts, long IDs and obvious residential address references. This is a conservative filter, not a guarantee to catch every form of personal data.
- Legacy background bulk promoter now returns a no-op. Worker startup and admin reads no longer promote/rebuild/override learning settings.
- Existing office-verified knowledge remains intact. No deletion or migration. Repeated questions should be approved only once the staff reviewer confirms the answer is general, correct, current and authorized for that office.

### 3. Offline regression tests

`whatsapp-bot/test/conversation-intelligence.test.js`:
- detects ambiguous turns, knowledge gaps, tool issues, fallbacks, multiple intents, corrections and staff handoff;
- verifies consecutive stall signals cannot mix applicants or question IDs;
- confirms null rates when there is no data (no fake precision);
- verifies metadata aggregation never returns applicant IDs, raw text, phone/identity tokens;
- forbids background approval; verifies staff replies create only a pending review item, never an automatic entry in `masar_knowledge`.

Keep running the existing 540 synthetic QA scenarios from Phase 4. The new diagnostics are **additional**, and normal WhatsApp qualification paths remain unchanged.

## Safety and limitations

- Since database backup tooling isn't connected for taking a verified full production snapshot, we don't process whole historic chats in bulk or send raw transcripts to third-party LLM providers.
- The existing LLM planner, if separately enabled by admin, still has its prior conversation context behavior; the new conversation analytics adds **no further** sharing of applicant texts.
- Review signals are **potential issues, not confirmed bot mistakes**. Human review via authorized CRM access is still needed before deciding a specific response was wrong.
- Older `agent_turn` events without `quality_signals` cannot be retrospectively assessed from message content by the new method; the dashboard will gradually accumulate data.
- We do not auto-create synthetic test cases from personal messages; approved staff can already add an anonymized synthetic case in Quality Center.
- Costs: metadata analysis is deterministic inside the Node worker and uses **zero additional LLM API calls**. It can increase audit JSON slightly.

## Suggested rollout check after Railway SUCCESS

1. AI Agent → مركز الجودة → ذكاء المحادثات الفعلية; verify metrics show with a time range, including empty cases.
2. Ask a test WhatsApp user: "مش فاهم السؤال"; verify next `agent_turn` contains `quality_signals`.
3. Have a staff member answer a **synthetic** candidate question; check it shows pending under AI Agent → المعرفة and isn't used as published office fact until approval.
4. Run the existing 540 synthetic QA scenarios and Node/Vite CI.
5. Verify privacy/human-review rules before onboarding any automatic bulk review workflow.

Next hard gate for raw-conversation mining: take and verify an independent Supabase database **and storage** backup with an authorized tool, and implement consent/retention scope, redaction and office isolation. Do not claim this is already complete.
