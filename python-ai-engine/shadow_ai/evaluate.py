"""Synthetic offline evaluation; measures structured planning, not LLM quality."""
from __future__ import annotations

import json
import statistics
from .core import plan

AREAS = [
    {"id": "haram-rest", "name": "الهرم مطاعم", "place_key": "الهرم",
     "work_mode": "restaurants", "active": True,
     "weekly_income_min": 3500, "weekly_income_max": 6000,
     "order_price": 38, "delivery_zone_km": 10},
    {"id": "zayed-market", "name": "الشيخ زايد ماركت", "place_key": "الشيخ زايد",
     "work_mode": "market", "active": True,
     "monthly_fixed_salary": 5225, "shift_hours": 9,
     "motorcycle_required": True, "benefits": ["تأمين اجتماعي", "تأمين طبي"]},
    {"id": "obour-market", "name": "العبور ماركت", "place_key": "العبور",
     "work_mode": "market", "active": True, "shift_hours": 9,
     "motorcycle_required": True},
    {"id": "nasr-market", "name": "مدينة نصر ماركت", "place_key": "مدينة نصر",
     "work_mode": "market", "active": True, "shift_hours": 9},
    {"id": "nasr-rest", "name": "مدينة نصر مطاعم", "place_key": "مدينة نصر",
     "work_mode": "restaurants", "active": True, "weekly_income_min": 4000},
]


def user(text: str) -> dict:
    return {"role": "applicant", "text": text}


def preview(area_id: str) -> dict:
    return {"role": "agent", "metadata": {"preview_area_id": area_id}}


CASES = [
    {
        "name": "first_message_asks_vehicle", "history": [user("هو الشغل لازم موتوسيكل ولا عربية؟")],
        "action": "clarify_job_system", "intents": ["job_requirements"]
    },
    {
        "name": "shift_followup_remembers_preview", "history": [user("العبور"), preview("obour-market"), user("شفتات مثلاً؟")],
        "action": "answer_shift_from_crm", "intents": ["shift_details"], "job": "obour-market",
        "warning": "shift_start_end_times_not_verified"
    },
    {
        "name": "salary_compare_mismatched_periods",
        "history": [user("الهرم ولا الشيخ زايد أفضل من ناحية المرتب؟")],
        "action": "compare_registered_jobs", "intents": ["compare_areas", "pay_details"],
        "warning": "do_not_compare_weekly_and_monthly_income"
    },
    {
        "name": "residence_not_qualification",
        "history": [user("أنا ساكن في المنصورية وعايز شغل قريب ومشوار قليل")],
        "action": "clarify_commute", "intents": ["nearby_work"],
        "residence": "المنصوريه"
    },
    {
        "name": "area_requires_explicit_confirmation",
        "history": [user("عايز اشتغل في العبور")],
        "action": "request_explicit_work_area_confirmation",
        "intents": ["work_area_proposal"]
    },
    {
        "name": "negated_work_area_is_not_commitment",
        "history": [user("مش عايز اشتغل في العبور")],
        "action": "clarify_or_continue", "absent_intent": "work_area_proposal"
    },
    {
        "name": "all_history_not_last_10",
        "history": [user("أنا ساكن في المنصورية")] + [user("استفسار سابق") for _ in range(50)] +
                   [preview("obour-market"), user("طيب الشيفت كام ساعة؟")],
        "action": "answer_shift_from_crm", "residence": "المنصوريه",
        "job": "obour-market", "intents": ["shift_details"]
    },
    {
        "name": "later_residence_correction",
        "history": [user("انا ساكن في المنصورة"), user("سؤال سابق"), user("اقصد المنصورية مش المنصورة"),
                    user("عايز شغل قريب")],
        "action": "clarify_commute", "residence": "المنصوريه"
    },
    {
        "name": "multi_intent_compare_with_commute",
        "history": [user("الهرم ولا الشيخ زايد أحسن في المرتب والقرب من البيت؟")],
        "action": "compare_registered_jobs",
        "intents": ["compare_areas", "pay_details", "nearby_work"],
        "warning": "delivery_zone_is_not_home_commute"
    },
    {
        "name": "ask_requirements_in_last_job",
        "history": [preview("zayed-market"), user("طيب لازم موتوسيكل وإيه المميزات؟")],
        "action": "answer_requirements_from_crm", "job": "zayed-market",
        "intents": ["job_requirements"]
    },
    {
        "name": "ambiguous_shift_requires_clarification",
        "history": [user("مدينة نصر الشفتات كام ساعة؟")],
        "action": "clarify_job_system", "intents": ["shift_details"]
    },
    {
        "name": "resume_without_new_welcome",
        "history": [user("نكمل التقديم من مكان ما وقفنا")],
        "action": "resume_application_without_reset", "intents": ["continue_application"]
    },
]


def check_case(case: dict) -> tuple[bool, list[str], dict]:
    data = {"history": case["history"], "areas": AREAS}
    result = plan(data)
    problems = []
    if result["action"] != case["action"]:
        problems.append("wrong action: " + result["action"])
    for intent in case.get("intents", []):
        if intent not in result["intents"]:
            problems.append("missing intent: " + intent)
    if case.get("absent_intent") in result["intents"]:
        problems.append("forbidden intent present")
    if case.get("job") and result["context"]["current_job_id"] != case["job"]:
        problems.append("missing previous job context")
    if case.get("residence") and result["context"]["residence_area"] != case["residence"]:
        problems.append("residence context wrong")
    if case.get("warning") and case["warning"] not in result["warnings"]:
        problems.append("missing safety warning: " + case["warning"])
    if result["qualification_changed"] or result["work_area_confirmed"]:
        problems.append("illegal candidate state change")
    return not problems, problems, result


def evaluate() -> dict:
    samples = [check_case(c) for c in CASES]
    latencies = sorted(r["latency_ms"] for _, _, r in samples)
    return {
        "engine": "python-shadow-rules-v1",
        "test_scope": "synthetic structured planning only; not a production LLM comparison",
        "cases": len(CASES), "passed": sum(ok for ok, _, _ in samples),
        "failed_cases": [{"name": c["name"], "problems": issue}
                         for c, (ok, issue, _) in zip(CASES, samples) if not ok],
        "median_ms": round(statistics.median(latencies), 3),
        "p95_ms": latencies[min(len(latencies) - 1, int(len(latencies) * .95))],
    }


if __name__ == "__main__":
    report = evaluate()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["failed_cases"]:
        raise SystemExit(1)
