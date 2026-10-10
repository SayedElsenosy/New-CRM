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
from .llm_provider import EvaluationConfig, GroqSyntheticProposer, DisabledNetwork, ProviderCallError
from .model_boundary import safe_model_action

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "benchmarks" / "paired_cases.json"
FREE_PILOT_MODEL = "openai/gpt-oss-20b"
FREE_PILOT_CASE_IDS = ("ad_vehicle", "income_vs_commute", "history_50")
FREE_PILOT_MAX_CASES = len(FREE_PILOT_CASE_IDS)


def check_free_pilot(config: EvaluationConfig, *, approved_in_console: bool,
                     free_tier_env: str) -> None:
    """Cannot remotely attest Groq billing state. Require two explicit confirmations."""
    if not approved_in_console or free_tier_env != "YES":
        raise DisabledNetwork("Verify the Groq organization is Free (not Developer) first")
    if config.model != FREE_PILOT_MODEL:
        raise DisabledNetwork("Free pilot uses only the checked Groq model")
    config.check()



def run_synthetic(config: EvaluationConfig, *, max_cases: int = 3,
                  proposer: GroqSyntheticProposer | None = None) -> dict:
    config.check()
    if not 1 <= max_cases <= FREE_PILOT_MAX_CASES:
        raise ValueError("Free pilot never exceeds three calls")
    dataset = json.loads(FIXTURE_PATH.read_text("utf-8"))
    if dataset.get("version") != 1:
        raise ValueError("unrecognized synthetic fixture version")
    by_id = {row["id"]: row for row in dataset["cases"]}
    if not all(key in by_id for key in FREE_PILOT_CASE_IDS):
        raise ValueError("Missing synthetic benchmark case")
    proposer = proposer or GroqSyntheticProposer(config)
    rows = []
    for key in FREE_PILOT_CASE_IDS[:max_cases]:
        case = by_id[key]
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
                "model_action_matches_reference": (accepted == expected) if accepted else None,
                "fallback_to_rules": accepted is None,
                "latency_ms": proposer.last_latency_ms,
                "prompt_tokens": proposer.last_usage.get("prompt_tokens", 0),
                "completion_tokens": proposer.last_usage.get("completion_tokens", 0),
            })
        except Exception as error:
            # Never serialize raw provider errors, prompts, tokens or response.
            # The only remote diagnostic we retain is an allowlisted status.
            status = error.status if isinstance(error, ProviderCallError) else (
                "invalid_model_response" if isinstance(error, RuntimeError)
                else "local_validation_error"
            )
            rows.append({
                "id": case["id"], "proposed_action": "provider_error",
                "proposed_accepted": False,
                "accepted_action": baseline["action"],
                "matches_labeled_action": baseline["action"] == case.get("expect", {}).get("python_action"),
                "model_action_matches_reference": None,
                "provider_error_status": status,
                "provider_permission_code": error.permission_code if isinstance(
                    error, ProviderCallError) else None,
                "fallback_to_rules": True,
                "latency_ms": proposer.last_latency_ms,
                "prompt_tokens": 0, "completion_tokens": 0,
            })
            # Fail fast: do not burn all Free-tier attempts if authentication,
            # rate limits, unsupported parameters or network calls are broken.
            break
    timings = [r["latency_ms"] for r in rows if r["latency_ms"] is not None]
    return {
        "source": "synthetic_checked_in_cases_only",
        "live_llm_requests_attempted": proposer.request_count,
        "cases_evaluated": len(rows),
        "action_matches_reference": sum(r["matches_labeled_action"] for r in rows),
        "model_only_matches_reference": sum(r.get("model_action_matches_reference") is True for r in rows),
        "model_only_evaluable_cases": sum(r.get("model_action_matches_reference") is not None for r in rows),
        "provider_errors": sum(bool(r.get("provider_error_status")) for r in rows),
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
    parser.add_argument("--confirm-free-tier", action="store_true",
                        help="I checked Groq Console: the selected organization is Free, not Developer")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show selected synthetic scenarios without any network or API key")
    args = parser.parse_args()
    if args.dry_run:
        print(json.dumps({"mode": "OFFLINE_ONLY", "network_attempts": 0,
                          "model": FREE_PILOT_MODEL,
                          "max_cases": FREE_PILOT_MAX_CASES,
                          "cases": list(FREE_PILOT_CASE_IDS),
                          "requires_free_account_verification": True},
                         ensure_ascii=False, indent=2))
        return
    if not (args.live and args.synthetic_only_confirmed and args.confirm_free_tier):
        raise SystemExit("No external calls: all three explicit confirmation flags are required")
    import os
    config = EvaluationConfig.from_environment(approved=True)
    try:
        check_free_pilot(config, approved_in_console=args.confirm_free_tier,
                         free_tier_env=os.environ.get("SHADOW_GROQ_FREE_TIER_CONFIRMED", ""))
    except DisabledNetwork as exc:
        raise SystemExit(str(exc)) from None
    report = run_synthetic(config, max_cases=args.max_cases)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
