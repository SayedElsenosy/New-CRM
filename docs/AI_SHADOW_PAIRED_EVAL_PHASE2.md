# Node.js vs Python AI Shadow — paired synthetic baseline (2026-10-10)

## What was actually measured

The shared dataset has **10 synthetic conversations** covering an ad-led
vehicle question, remembered shift details, pay-vs-commute comparison,
residence vs work area, explicit work-area proposal, negated area choice,
50-turn history, ambiguous job systems, and resuming an application.

Both receive identical transcript history and sample CRM job facts, adapted
to their **existing input contracts**. Node.js calls production
planTurn() **offline** and produces a user-facing reply; Python uses the
experimental rule-based planner and produces only a structured action and
CRM references. No external LLM, WhatsApp, Supabase, or applicant data is used.

## First verified GitHub Actions results

Commit: 1332665ba9146d3cb657f77c4a46ddfc1c3bf7db
(comparative baseline run 38050817199).

| Metric | Python shadow rules | Node production flow offline |
|---|---:|---:|
| Synthetic scenarios | 10 | 10 |
| Scenarios meeting their **different**, explicitly defined contracts | 10/10 | 10/10 |
| Checks meeting each engine's contract | 56/56 | 32/32 |
| Median isolated execution time (ms) | 0.097 | 1.03 |

**This does not show Python is smarter or ~10x faster in production.**
Python proposes one structured action; Node builds a reply using a larger
code path, and the thresholds/number of checks differ by engine. The
timings exclude LLM calls, DB/WhatsApp latency, network effects and scale.
Benchmarks on developer/CI machines are not representative of production.

The current Node flow returns no explicit agent_action field in two
cases ("مش عايز اشتغل في العبور" and "نكمل التقديم..."), even though
its safety and response contract checks passed. This is a *telemetry
classification gap*, not proof of incorrect user-facing answers.

## LLM experiment boundary

A separate Python model adapter accepts an injected provider callable
during unit tests. **No live provider is wired or called**.

- Sends no raw transcripts, residence, candidate phone or staff notes to
  the injected provider — only allowlisted intent labels and minimal
  structured CRM facts.
- Rejects invented actions, unsupported intents and attempts to confirm
  work areas or recruitment qualification.
- Does not trust LLM-origin freeform replies, salary claims or distances.
- Falls back to the offline planner if the model errors or returns an unsafe
  proposal.
- Has no live WhatsApp sender, DB writer, or background tasks.

## Next acceptance gates before any rollout

1. Build independently reviewed *de-identified* conversations with labels
   for human quality (intent, context, hallucinations, repeated question).
2. Compare the current Node LLM and any future Python LLM with equivalent
   actual model/provider settings, prompt budgets and information retrieval.
3. Record real p50/p95 end-to-end response time from intake to WhatsApp
   send, not just isolated rule execution times.
4. Confirm office isolation, role permissions, cost caps and rollback.
5. Only enable read-only Python shadow mode on a tiny opted-in test sample
   after privacy/security review and a tested data backup.

The production architecture remains **React + Node.js + Supabase**;
Python is a test package, not a deployed second worker.
