# Python Shadow AI Lab — SET CRM

**Status: experimental, read-only, disabled in production.** This directory
does not replace the Node.js WhatsApp connector, Supabase API or React dashboard.
There is no Railway service or database migration.

## Why this exists

Python is useful for rapid analysis, offline evaluations and later RAG/ML
experimentation; language choice **does not itself improve an LLM's Arabic
understanding or make an interactive dashboard faster**. The existing React +
Node.js app remains the production source of truth until controlled comparison
demonstrates a benefit.

## Run offline — no API keys, no paid inference

Python 3.11+:

    cd python-ai-engine
    python -m unittest discover -s tests -v
    python -m shadow_ai.evaluate

Results describe **rule-based structured planning only**, not human-level
intelligence, LLM accuracy or production response time. Synthetic fixtures
are deliberately derived from classes of errors seen in manual CRM testing;
they contain no real candidate transcripts or phone numbers.

## Optional local-only service (NOT DEPLOYED)

    python -m venv .venv
    . .venv/bin/activate
    pip install -r requirements.txt
    export AI_SHADOW_TOKEN='<random 32+ character internal secret>'
    uvicorn shadow_ai.service:app --host 127.0.0.1 --port 8097 --no-access-log

The route is POST /v1/plan with header X-AI-Shadow-Token. The service accepts
structured synthetic/carefully reviewed inputs, not public WhatsApp webhooks.
It has no database credentials, chat sender, eligibility mutation or staff
access. **Do not expose this experiment publicly without a separate security
and privacy review.** No token is checked into git.

## Input schema (v1)

    {
      "history": [
        {"role":"applicant","text":"أنا ساكن في المنصورية"},
        {"role":"agent","metadata":{"preview_area_id":"haram-market"}},
        {"role":"applicant","text":"الشيفت كام ساعة؟"}
      ],
      "areas":[
        {
          "id":"haram-market",
          "name":"الهرم ماركت",
          "place_key":"الهرم",
          "work_mode":"market",
          "active":true,
          "shift_hours":9,
          "monthly_fixed_salary":5225,
          "motorcycle_required":true
        }
      ]
    }

Output contains only a proposed action, recognized intent categories,
minimal supporting CRM facts, relevant context, uncertainty warnings, and
one missing question when needed. It never returns a freeform LLM response
or approves/denies an applicant. It always marks
work_area_confirmed=false and qualification_changed=false.

Full-history indexing scans every supplied turn, bounded at 5,000 for a single
local evaluation. Future production retrieval must support pagination and
persistent indexes to scale without losing context; this prototype does not
claim to solve unbounded 100,000-message histories.

## Paired Node/Python comparison (Phase 2)

A single synthetic fixture file at benchmarks/paired_cases.json is used by
both implementations. It contains **no actual applicant transcripts, phones,
office secrets, or external API calls**.

From the project root, after npm install:

    PYTHONPATH=python-ai-engine python -m shadow_ai.paired_eval

Run Python contract tests without Node:

    cd python-ai-engine
    python -m unittest discover -s tests -v
    python -m shadow_ai.paired_eval --python-only --fail-on-python

The comparative report is printed in GitHub Actions. **Do not rank**
the engines by raw passed counts or wall-clock times: the Python experiment
returns a proposed structured action; the current Node flow returns a
candidate-facing reply. They are checked on different observable contracts.
Neither offline rule test exercises Groq/OpenAI inference, WhatsApp delivery,
or actual production scale. To compare answer quality, both need equivalent
LLM calls and human reviewed anonymized dialogues.

### LLM proposal boundary — no live model calls yet

shadow_ai.model_boundary defines an optional injectable model callback.
It sends only allowlisted intent categories, structured CRM facts, and a
current job identifier — **never raw chat text, phone numbers, residence,
candidate identity or hidden reasoning**. It rejects suggestions without
detected intents or a known job, forbidden CRM writes, attempts to change
qualification and speculative free-form answers; provider errors revert to
the current rule planner. Unit tests use a fake local model, **not an API**.

There is no public network client, API token, provider credentials or
deployment in this phase. Before a live LLM comparison we must decide
whether text data can be sent to a specific provider lawfully and securely,
perform per-office access review, set usage limits, and evaluate actual answer
quality rather than assuming Python itself produces better text.

## Phase 3 — first Free-only 3-message pilot (NOT RUN YET)

The Free-only pilot was first attempted on 2026-10-10: 3 requests returned provider_error, with no LLM proposals accepted. An unsupported GPT-OSS reasoning_format parameter was found and corrected; a safe HTTP status will be reported on the next one-call diagnostic run.
The Groq Free plan uses quota limits; Developer has usage-based billing.
A script cannot verify the organization's billing tier from the current
Groq Chat API. You MUST personally check your active organization is
**Free, not Developer**, before proceeding. Do not upgrade or add a
payment method just to run this experiment.

Official docs:
- Free quotas: https://console.groq.com/docs/rate-limits
- Free vs Developer billing: https://console.groq.com/docs/billing-faqs
- Create a separate API key: https://console.groq.com/keys

The current Free pilot uses **openai/gpt-oss-20b** and three synthetic
scenarios: an advertising lead's motorcycle question; a comparison
of area income and commute distance; and a conversation with 50
intervening turns requiring context recall.

No external LLM requests occur in CI or Railway. Provider testing is
read-only: no Supabase, WhatsApp, applicant details, hiring decision,
or production key. This pilot CLI defaults to ONE attempt (optionally 1-3),
maximum 180 generated tokens each, no automatic retries and a
12-second request timeout, and reports actions, usage and latency only.

### Windows — offline preview (no key, no network)

Open PowerShell in the python-ai-engine folder:

    .\run_free_pilot.ps1 -DryRun

### Windows — only after verifying the Free account

1. Visit https://console.groq.com and check Settings > Billing.
   It must say Free, NOT Developer. Otherwise STOP.
2. Create a NEW project-specific evaluation key in the Free organization
   at https://console.groq.com/keys. Never paste it in ChatGPT,
   a screenshot, GitHub or production Railway variables.
3. Open PowerShell in the python-ai-engine folder. If you downloaded an
   older ZIP, refresh the following three files from the main GitHub branch:

       $raw = "https://raw.githubusercontent.com/SayedElsenosy/New-CRM/main/python-ai-engine"
       Invoke-WebRequest "$raw/shadow_ai/llm_provider.py" -OutFile ".\shadow_ai\llm_provider.py"
       Invoke-WebRequest "$raw/shadow_ai/live_eval.py" -OutFile ".\shadow_ai\live_eval.py"
       Invoke-WebRequest "$raw/run_free_pilot.ps1" -OutFile ".\run_free_pilot.ps1"

   Then run the optional no-network check and ONE diagnostic request:

       .\run_free_pilot.ps1 -DryRun
       .\run_free_pilot.ps1

4. Type FREE only after confirming the current organization is Free.
   Paste the new evaluation key into the **hidden** PowerShell prompt.
5. The script tests three synthetic cases, displays results and
   clears temporary key variables. If a 429 occurs, the free quota
   was reached: DO NOT upgrade or retry on a paid organization.

Do not permanently relax restrictive PowerShell execution policy.
Use only a safe, per-process execution policy if required.

### Safety limits

Before a real request the CLI requires all of the following:
- flags --live --synthetic-only-confirmed --confirm-free-tier
- environment SHADOW_LLM_NETWORK_ENABLED=YES
- environment SHADOW_GROQ_FREE_TIER_CONFIRMED=YES
- a separate test key and exact model ID openai/gpt-oss-20b

These safeguards are NOT proof of a Free billing account.
If someone falsely attests a paid organization, model calls could
still incur cost. Therefore NEVER run against Developer.

The generic provider class has a separate 10-attempt ceiling for
test safety; the approved Free-pilot CLI is stricter: 1 default, at most 3.
A provider failure halts the run immediately and prints only a safe HTTP
status (401 invalid key, 400 unsupported request, 429 free rate limit)
without revealing the full API error body or the key. Reported action
matches from fallback rules do NOT imply the LLM answered correctly.
All prompts are synthetic; passing doesn't prove human-level chat
quality, real WhatsApp throughput or correctness on actual applicants.

### Diagnosing a Groq 403 (without more requests)

Groq documents HTTP 403 for models blocked by either organization or project
permissions. Before re-running anything, open the Groq Console, select the
**same Personal / Default Project** as the evaluation key, and check:

- Settings > Organization > Limits: ensure openai/gpt-oss-20b is not blocked.
- Settings > Projects > Limits: ensure the model is not blocked by the project.
- Groq Console's API Logs can show a reason for the existing failed request.

The CLI now allows only these documented diagnostic codes in its output:
model_permission_blocked_org and model_permission_blocked_project.
For other 403s it prints provider_permission_code = null, not a guessed
cause, and never displays raw provider messages or the API key.
Do not disable intentional security restrictions or switch to a paid plan.
Wait for verification before making a *single* further test request.

Official source: https://console.groq.com/docs/model-permissions

## Safe migration steps

1. Run and review synthetic offline fixtures.
2. Evaluate existing Node.js agent on the **same de-identified cases** in
   isolated mode; compare quality, latency and tokens, not languages alone.
3. Add optional LLM planner in Python only if it improves these metrics.
4. Review data minimization and per-office isolation; obtain a tested backup
   before any new writes/migrations.
5. Deploy authenticated shadow traffic on a small sample of opted-in test
   conversations, never send its decisions to WhatsApp.
6. Enable per-office fallback only after satisfactory results and staff sign-off.

## Dashboard decision

Keep React for the dashboard: it's already a strong fit for an interactive
mobile UI. Python may later power analytics or AI endpoints via FastAPI; this
does not require rewriting the frontend in Django/Streamlit, which would
increase migration work and risks without a demonstrated performance win.
