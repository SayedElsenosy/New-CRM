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
