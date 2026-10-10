"""Opt-in LLM evaluation on checked-in synthetic CRM fixtures only.

This is never executed by CI or the production WhatsApp service.
Run with explicit flags AND SHADOW_LLM_NETWORK_ENABLED=YES.
"""
from __future__ import annotations
import argparse
import json
import statistics
from pathlib import Path

from .core import plan
from .llm_provider import EvaluationConfig, GroqSyntheticProposer, MAX_CASES
from .model_boundary import safe_model_action

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "benchmarks" / "paired_cases.json"


def run_synthetic(config: EvaluationConfig, *, max_cases: int = 3,
                  proposer: GroqSyntheticProposer | None = None) -> dict:
    config.check()
    if not 1 <= max_cases <= MAX_CASES:
        raise ValueError("max_cases outside approved limit")
    dataset = json.loads(FIXTURE_PATH.read_text("utf-8"))
    if dataset.get("version") != 1:
        raise ValueError("unrecognized synthetic fixture version")
    proposer = proposer or GroqSyntheticProposer(config)
    rows = []
    for case in dataset["cases"][:max_cases]:
        baseline = plan({"history": case["history"], "areas": dataset["areas"]})
        try:
            suggestion = proposer.propose(baseline=baseline, history=case["history"])
            accepted = safe_model_action(suggestion, baseline)
            expected = case.get("expect", {}).get("python_action")
            rows.append({
                "id": case["id"], "proposed_action": str(suggestion.get("action", ""))[:60]
                if isinstance(suggestion, dict) else "invalid",
                "proposed_accepted": accepted is not None,
                "accepted_action": accepted or baseline["action"],
                "matches_labeled_action": (accepted or baseline["action"]) == expected,
                "fallback_to_rules": accepted is None,
                "latency_ms": proposer.last_latency_ms,
                "prompt_tokens": proposer.last_usage.get("prompt_tokens", 0),
                "completion_tokens": proposer.last_usage.get("completion_tokens", 0),
            })
        except Exception:
            # Error names/codes only, no raw provider response, prompt or secrets.
            rows.append({
                "id": case["id"], "proposed_action": "provider_error",
                "proposed_accepted": False,
                "accepted_action": baseline["action"],
                "matches_labeled_action": baseline["action"] == case.get("expect", {}).get("python_action"),
                "fallback_to_rules": True,
                "latency_ms": proposer.last_latency_ms,
                "prompt_tokens": 0, "completion_tokens": 0,
            })
    timings = [r["latency_ms"] for r in rows if r["latency_ms"] is not None]
    return {
        "source": "synthetic_checked_in_cases_only",
        "live_llm_requests_attempted": proposer.request_count,
        "cases_evaluated": len(rows),
        "action_matches_reference": sum(r["matches_labeled_action"] for r in rows),
        "model_proposals_accepted": sum(r["proposed_accepted"] for r in rows),
        "fallback_count": sum(r["fallback_to_rules"] for r in rows),
        "median_model_latency_ms": round(statistics.median(timings), 2) if timings else None,
        "total_prompt_tokens": sum(r["prompt_tokens"] for r in rows),
        "total_completion_tokens": sum(r["completion_tokens"] for r in rows),
        "note": "No user-facing replies, WhatsApp traffic or real applicant records. Provider usage may be billed.",
        "cases": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Explicit opt-in evaluation with a REAL provider on synthetic-only fixtures.")
    parser.add_argument("--live", action="store_true",
                        help="Enable network request when environment guard also says YES")
    parser.add_argument("--synthetic-only-confirmed", action="store_true")
    parser.add_argument("--max-cases", type=int, default=3)
    args = parser.parse_args()
    if not (args.live and args.synthetic_only_confirmed):
        raise SystemExit("No external calls: --live and --synthetic-only-confirmed are required")
    config = EvaluationConfig.from_environment(approved=True)
    # Config validates network flag, model name and dedicated secret.
    report = run_synthetic(config, max_cases=args.max_cases)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
