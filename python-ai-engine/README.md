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

## Phase 3 — optional REAL LLM experiment (NOT ENABLED)

An opt-in Groq-compatible HTTPS client now exists in
shadow_ai.llm_provider, with a fixed Groq endpoint, bounded timeouts,
maximum **180 generated tokens** and a hard cap of **10 requests per
run**. It operates **only** on the synthetic benchmark file bundled with
this repository. It must not be given actual candidates' WhatsApp chats,
phone numbers, residence addresses, personal IDs or credentials.

### Without model calls or costs (default)

    cd python-ai-engine
    python -m unittest discover -s tests -v

The tests inject mock provider outputs, check request bounds and do not
access external services.

### Only if you approve provider data use and pricing

Use a **separate evaluation-only Groq key**; never reuse/copy the live
production key into GitHub or chat. API access may incur charges even if
a particular model has a free tier. The script has no hard monetary cap
because providers set prices and quotas independently.

On Windows PowerShell:

    cd python-ai-engine
    $env:SHADOW_LLM_NETWORK_ENABLED = 'YES'
    $env:SHADOW_GROQ_MODEL = '<model-supported-by-your-account>'
    $env:SHADOW_GROQ_API_KEY = '<your-evaluation-key>'
    python -m shadow_ai.live_eval --live --synthetic-only-confirmed --max-cases 3

Without **all** those values and flags the script exits before a
network request. Maximum max-cases is 10; default is 3. The model
is called with temperature 0 and JSON output. Afterwards clear:

    Remove-Item Env:SHADOW_GROQ_API_KEY

### What is measured

- Proposed action, policy acceptance, fallback and labeled intent agreement
- Token counts reported by provider, median API response latency
- NOT human-level understanding or candidate-facing reply quality:
  this is solely a read-only model-assisted planning experiment

No keys are stored in files, Railway or CI. The Python lab is NOT
connected to WhatsApp. Running this external trial requires explicit
approval for potential charges and for transmitting synthetic prompts
to that provider.

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
