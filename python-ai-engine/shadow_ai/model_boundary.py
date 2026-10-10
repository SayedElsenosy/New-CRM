"""Provider-neutral, read-only LLM proposal boundary for the Python lab.

No network client in this module. Inject a local/mock callable in tests.
Live provider use MUST be separately enabled only after security approval.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any
from .core import plan

# Only safe actions that the offline rule planner itself could have chosen.
ALLOWED_ACTIONS = frozenset({
    "compare_registered_jobs", "answer_shift_from_crm",
    "answer_requirements_from_crm", "clarify_job_system",
    "clarify_commute", "request_explicit_work_area_confirmation",
    "resume_application_without_reset", "clarify_or_continue",
})
ALLOWABLE_BY_INTENT = {
    "compare_registered_jobs": "compare_areas",
    "answer_shift_from_crm": "shift_details",
    "answer_requirements_from_crm": "job_requirements",
    "clarify_commute": "nearby_work",
    "request_explicit_work_area_confirmation": "work_area_proposal",
    "resume_application_without_reset": "continue_application",
}
MAX_EVIDENCE = 8


def minimal_model_context(baseline: dict[str, Any]) -> dict[str, Any]:
    """Allowlisted CRM-derived facts and intent labels. No raw transcripts."""
    evidence = []
    safe_keys = ("id", "place_key", "work_mode", "shift_hours", "shift_start_time",
                 "shift_end_time", "monthly_fixed_salary", "weekly_income_min",
                 "weekly_income_max", "order_price", "motorcycle_required")
    for row in baseline.get("crm_evidence", [])[:MAX_EVIDENCE]:
        if isinstance(row, dict):
            evidence.append({k: row[k] for k in safe_keys if row.get(k) is not None})
    return {
        "schema_version": 1,
        "request": "Recommend one safe intent-dependent operational action; never approve a candidate.",
        "intents": list(baseline.get("intents", []))[:8],
        "previous_action": baseline.get("action", "clarify_or_continue"),
        "current_job_id": baseline.get("context", {}).get("current_job_id"),
        "work_area_confirmed": False,
        "qualification_changed": False,
        "crm_evidence": evidence,
        "warnings": list(baseline.get("warnings", []))[:12],
    }


def safe_model_action(candidate: Any, baseline: dict[str, Any]) -> str | None:
    """Reject model-origin actions not supported by the rules and source facts."""
    if not isinstance(candidate, dict):
        return None
    if set(candidate) - {"action", "confidence", "reason_code"}:
        return None
    action = candidate.get("action")
    if action not in ALLOWED_ACTIONS:
        return None
    confidence = candidate.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        return None
    if not 0.0 <= confidence <= 1.0 or confidence < 0.80:
        return None
    # The model can only refine within the same already-detected intents;
    # it cannot manufacture a job context or eligibility from the transcript.
    needed = ALLOWABLE_BY_INTENT.get(action)
    if needed and needed not in baseline.get("intents", []):
        return None
    if action in {"answer_shift_from_crm", "answer_requirements_from_crm"}:
        if not baseline.get("context", {}).get("current_job_id"):
            return None
    return action


def plan_with_optional_model(
    payload: dict[str, Any],
    *, model: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    enabled: bool = False,
) -> dict[str, Any]:
    """No provider network requests; injected model cannot change evidence/state.

    Returns a proposed action for shadow evaluation, never an outbound reply.
    """
    baseline = plan(payload)
    baseline["model_used"] = False
    baseline["model_proposal_accepted"] = False
    baseline["model_fallback"] = "disabled"
    if not enabled or model is None:
        return baseline
    context = minimal_model_context(baseline)
    try:
        proposal = model(context)
    except Exception:
        # No raw provider exception; fail closed to deterministic baseline.
        baseline["model_fallback"] = "provider_error"
        return baseline
    action = safe_model_action(proposal, baseline)
    if action is None:
        baseline["model_used"] = True
        baseline["model_fallback"] = "rejected"
        return baseline
    baseline["model_used"] = True
    baseline["model_proposal_accepted"] = True
    baseline["model_fallback"] = None
    baseline["action"] = action
    # Evidence and immutable safeguards remain the rule planner's output.
    return baseline
