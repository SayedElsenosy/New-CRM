# Hybrid AI baseline — 2026-10-10

## Scope and safety

This report is an **aggregate-only** snapshot from existing production
decision metadata; no candidate text, numbers, identifiers or prompts were
copied. It is not an A/B comparison and does not change the live agent.

Source: Supabase public.masar_agent_decisions, grouped by planner_mode, with
created_at in the preceding 14 days. Values below are milliseconds of the
recorded LLM call only (when available), **not** total WhatsApp end-to-end
response latency or correctness.

| Planner mode | Decisions | With LLM latency | Median LLM ms | P95 LLM ms | Fallback count |
|---|---:|---:|---:|---:|---:|
| llm_live | 51 | 51 | 519.0 | 897.5 | 0 |
| llm_shadow | 41 | 41 | 528.0 | 1000.0 | 0 |
| llm_assist | 38 | 38 | 516.0 | 740.7 | 0 |
| deterministic | 26 | 0 | unavailable | unavailable | 0 |
| fallback | 21 | 0 | unavailable | unavailable | 21 |

Interpretation: the recorded LLM-call median is roughly half a second, but
total messaging latency can include queue waiting, history retrieval,
Supabase reads/writes and WhatsApp sending. There were no detailed
post-deployment processing-stage rows in the preceding seven days when
this snapshot was taken. Do not compare sub-millisecond Python rule
parsing with an actual LLM request as though they performed the same work.

## Offline Python starting point

The separate Python shadow-lab test suite includes 12 *synthetic*, non-PII
Egyptian Arabic cases plus safety/unit tests. It verifies constrained intent
classification, full supplied history inspection, correction handling,
verified CRM-only job facts, and no automatic qualification or send.
GitHub Actions is the source of test success; numbers may differ across
machines. This is **not** evidence that Python produces better real chat
answers than the Node.js agent.

## Next measurable gates

- Run the same redacted test cases through both implementations with matched
  CRM context and equivalent model settings; separately score intent,
  unsupported claims, context retention, and question repetition.
- Collect end-to-end p50/p95 WhatsApp response latency, including queue,
  history, model and send stages on an approved test office.
- Evaluate a distinct LLM-backed Python planner on the same cases only if
  rule-based results show useful potential; record token usage and costs.
- Enable shadow reads on opted-in test conversations only after privacy,
  tenancy, authentication and rollback checks. Never change candidate state,
  initiate outbound sends or claim geo-qualification from residence.
- Keep React dashboard and existing Node WhatsApp runtime unless a specific
  independently measured bottleneck justifies migration.
