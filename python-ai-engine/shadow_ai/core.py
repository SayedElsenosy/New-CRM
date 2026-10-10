"""Read-only Egyptian Arabic conversation planner for offline/shadow evaluation.

This module does not send WhatsApp messages, mutate Supabase, decide hiring
eligibility, or call an LLM. It creates a constrained plan grounded in supplied
CRM facts; it is NOT a substitute for the current production agent.
"""
from __future__ import annotations

import re
import time
import unicodedata
from typing import Any

MAX_MESSAGES = 5000
MAX_AREAS = 400
INTENTS = (
    "compare_areas", "shift_details", "job_requirements", "pay_details",
    "nearby_work", "work_area_proposal", "correction", "continue_application",
)
_AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_DIACRITICS = re.compile(r"[\u064b-\u065f\u0670\u0640]")
_SPACE = re.compile(r"\s+")
_CLEAN = re.compile(r"[^\w\u0621-\u064a]+", re.UNICODE)
_RESIDENCE = re.compile(r"(?:\bساكن(?:ه)?\b|\bمقيم(?:ه)?\b|\bسكني\b|\bبيتي\b)")
_EXPLICIT_WORK = re.compile(
    r"(?:عايز\s+اشتغل\s+في|عاوز\s+اشتغل\s+في|اختار\s+شغل|"
    r"حابب\s+اشتغل\s+في|اقدر\s+التزم\s+(?:ب)?شغل|"
    r"موافق\s+على\s+شغل|انزل\s+شغل\s+في)"
)
_NEGATION = re.compile(r"(?:مش|لا|لاء|معنديش|غير)")
_QUESTION_MONEY = re.compile(r"(?:مرتب|راتب|الدخل|الفلوس|قبض|الاوردر|البونص)")
_QUESTION_SHIFT = re.compile(r"(?:الشيفت|شيفتات|شفت|الشفت|مواعيد|الورديه|ساعات\s+الشغل|من\s+كام\s+لكام)")
_QUESTION_VEHICLE = re.compile(r"(?:موتوسيكل|موتسيكل|متوسيكل|موتوسكل|عربيه|عربيه|رخصه|المميزات|شروط)")
_COMPARE = re.compile(r"(?:الفرق|مقارن|قارن|احسن|انسب|افضل|ولا|انهى\s+احسن)")
_NEARBY = re.compile(r"(?:اقرب|القرب|قريب|المواصلات|مشوار|مسافه|بعيد)")
_CORRECTION = re.compile(r"(?:قصدي|اقصد|اصحح|مش\s+.*\s+(?:ده|دي)|لا\s+انا)")
_CONTINUE = re.compile(r"(?:كمل|نكمل|نستكمل|نقدم|ابدأ\s+التقديم)")
_MAIN_PRIORITY = (
    ("distance", re.compile(r"(?:اهم\s+حاجه.*(?:قرب|مشوار)|مش\s+عايز\s+مشوار\s+بعيد)")),
    ("income", re.compile(r"(?:اهم\s+حاجه.*(?:مرتب|دخل|قبض)|المرتب\s+اهم)")),
    ("benefits", re.compile(r"(?:اهم\s+حاجه.*(?:تامين|مميزات)|المميزات\s+اهم)")),
)


def normalize(value: Any) -> str:
    """Normalization only; do not confuse residence with working eligibility."""
    text = unicodedata.normalize("NFKC", str(value or "")).translate(_AR_DIGITS).lower()
    text = _DIACRITICS.sub("", text)
    text = text.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")
    text = text.replace("ى", "ي").replace("ة", "ه")
    return _SPACE.sub(" ", _CLEAN.sub(" ", text)).strip()


def _applicant_turns(history: list[dict[str, Any]]) -> list[tuple[int, str]]:
    return [(i, normalize(t.get("text", ""))[:5000])
            for i, t in enumerate(history)
            if isinstance(t, dict) and t.get("role") in ("applicant", "user")
            and t.get("text")]


def _area_places(areas: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for a in areas:
        if not isinstance(a, dict) or a.get("active") is False:
            continue
        place = normalize(a.get("place_key") or a.get("name") or "")
        if place:
            grouped.setdefault(place, []).append(a)
    return grouped


def _mentioned_places(text: str, grouped: dict[str, list[dict[str, Any]]]) -> list[str]:
    found = []
    for place, rows in grouped.items():
        aliases = {place}
        for area in rows:
            for alias in area.get("aliases", []) or []:
                aliases.add(normalize(alias))
            raw = normalize(area.get("name"))
            if raw:
                aliases.add(raw)
        if any(len(alias) >= 3 and re.search(
                r"(?<!\w)" + re.escape(alias) + r"(?!\w)", text)
                for alias in aliases):
            found.append(place)
    return found


def _last_preview(history: list[dict[str, Any]], areas: list[dict[str, Any]]) -> str | None:
    known = {str(a.get("id")): a for a in areas if isinstance(a, dict) and a.get("id")}
    for turn in reversed(history):
        if not isinstance(turn, dict):
            continue
        if turn.get("role") not in ("agent", "staff", "assistant"):
            continue
        preview_id = str((turn.get("metadata") or {}).get("preview_area_id") or "")
        if preview_id in known:
            return preview_id
    return None


def _residence_from_message(text: str) -> str | None:
    # Coarse city / neighborhood label only. Exclude street numbers and phone
    # fragments; original transcript remains the source of truth in the CRM.
    if not _RESIDENCE.search(text):
        return None
    match = re.search(r"(?:ساكن(?:ه)?|مقيم(?:ه)?|سكني|بيتي)\s+(?:في\s+)?([\w\s]{3,55})", text)
    if not match:
        return None
    value = re.split(r"\s+(?:و|بس|لكن|وعايز|عايز|مش|وبس|عشان)\s+", match.group(1))[0]
    words = value.split()[:3]
    value = " ".join(words).strip()
    return value if value and not re.search(r"\d|@|http", value) else None


def _memory(history: list[dict[str, Any]]) -> dict[str, Any]:
    """Scan whole supplied conversation, not just the last N messages."""
    residence = None
    priority = None
    confidence_turn = None
    for index, text in _applicant_turns(history):
        extracted = _residence_from_message(text)
        if extracted:
            residence = extracted
            confidence_turn = index
        elif residence and _CORRECTION.search(text) and " مش " in f" {text} ":
            # A later explicit correction to an earlier stated residence
            # supersedes the old coarse label, even if it comes 100 turns later.
            positive = text.split(" مش ", 1)[0]
            positive = re.sub(r"^.*?(?:قصدي|اقصد|اصحح)\s+", "", positive).strip()
            if 2 < len(positive) < 50 and not re.search(r"\d|@", positive):
                residence = " ".join(positive.split()[-3:])
                confidence_turn = index
        for label, pattern in _MAIN_PRIORITY:
            if pattern.search(text):
                priority = label
    return {"residence_area": residence, "priority": priority,
            "residence_evidence_index": confidence_turn,
            "messages_scanned": len(history)}


def _intent_tags(text: str, distinct_places: list[str]) -> list[str]:
    intents = []
    if _COMPARE.search(text) and (len(distinct_places) >= 2 or "ماركت" in text and "مطاعم" in text):
        intents.append("compare_areas")
    if _QUESTION_SHIFT.search(text):
        intents.append("shift_details")
    if _QUESTION_VEHICLE.search(text):
        intents.append("job_requirements")
    if _QUESTION_MONEY.search(text):
        intents.append("pay_details")
    if _NEARBY.search(text):
        intents.append("nearby_work")
    if distinct_places and any(
            not _NEGATION.search(text[max(0, match.start() - 9):match.start()])
            for match in _EXPLICIT_WORK.finditer(text)):
        intents.append("work_area_proposal")
    if _CORRECTION.search(text):
        intents.append("correction")
    if _CONTINUE.search(text):
        intents.append("continue_application")
    return [i for i in INTENTS if i in intents]


def _job_facts(area: dict[str, Any]) -> dict[str, Any]:
    # Only structured CRM fields are eligible. Never parse salary or shift from
    # arbitrary ad copy and pretend it was verified.
    allowed = ("id", "name", "place_key", "work_mode", "shift_hours",
               "weekly_income_min", "weekly_income_max",
               "monthly_fixed_salary", "order_price", "delivery_zone_km",
               "shift_start_time", "shift_end_time",
               "motorcycle_required", "benefits")
    facts = {key: area[key] for key in allowed if key in area and area[key] is not None}
    return facts


def _comparison_flags(rows: list[dict[str, Any]]) -> list[str]:
    if not rows:
        return ["no_registered_job_data"]
    pay_kinds = set()
    for row in rows:
        if any(row.get(k) is not None for k in ("weekly_income_min", "weekly_income_max")):
            pay_kinds.add("weekly")
        if row.get("monthly_fixed_salary") is not None:
            pay_kinds.add("monthly")
    flags = []
    if len(pay_kinds) > 1:
        flags.append("do_not_compare_weekly_and_monthly_income")
    if any(r.get("delivery_zone_km") is not None for r in rows):
        flags.append("delivery_zone_is_not_home_commute")
    if any(r.get("shift_hours") is not None and
           r.get("shift_start_time") is None for r in rows):
        flags.append("shift_start_end_times_not_verified")
    return flags


def plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a read-only structured proposal; NEVER an automatic CRM action."""
    t0 = time.perf_counter()
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    history = payload.get("history")
    areas = payload.get("areas") or []
    if not isinstance(history, list) or len(history) > MAX_MESSAGES:
        raise ValueError("history must be a list of at most 5000 turns")
    if not isinstance(areas, list) or len(areas) > MAX_AREAS:
        raise ValueError("areas must be a list of at most 400 records")
    user_turns = _applicant_turns(history)
    text = user_turns[-1][1] if user_turns else ""
    if not text:
        raise ValueError("at least one applicant message is required")
    grouped = _area_places(areas)
    mentioned = _mentioned_places(text, grouped)
    memory = _memory(history)
    intents = _intent_tags(text, mentioned)
    preview_id = _last_preview(history, areas)
    active_job = next((a for a in areas if isinstance(a, dict)
                       and a.get("active") is not False
                       and str(a.get("id")) == preview_id), None)
    if not active_job and len(mentioned) == 1 and len(grouped.get(mentioned[0], [])) == 1:
        active_job = grouped[mentioned[0]][0]
    discussed = [area for place in mentioned for area in grouped.get(place, [])]
    if not discussed and active_job:
        discussed = [active_job]
    if "compare_areas" in intents:
        action = "compare_registered_jobs"
        next_question = ("هل الأهم عندك القرب من البيت ولا الدخل والمميزات؟"
                         if not memory["priority"] else None)
    elif "shift_details" in intents:
        action = "answer_shift_from_crm" if active_job else "clarify_job_system"
        next_question = None if active_job else "تقصد الشيفت في أنهي منطقة ونظام شغل؟"
    elif "job_requirements" in intents:
        action = "answer_requirements_from_crm" if active_job else "clarify_job_system"
        next_question = None if active_job else "شروط أنهي منطقة ونظام شغل تقصد؟"
    elif "nearby_work" in intents:
        action = "clarify_commute"
        next_question = "ممكن تحدد نقطة انطلاقك ومكان الشغل علشان نراجع المشوار؟"
    elif "work_area_proposal" in intents:
        action = "request_explicit_work_area_confirmation"
        next_question = "تؤكد إن دي منطقة الشغل اللي تقدر تلتزم بيها يوميًا؟"
    elif "continue_application" in intents:
        action = "resume_application_without_reset"
        next_question = None
    else:
        action = "clarify_or_continue"
        next_question = None
    facts = [_job_facts(row) for row in discussed[:8]]
    warnings = _comparison_flags(facts)
    if "nearby_work" in intents and "delivery_zone_is_not_home_commute" not in warnings:
        warnings.append("no_verified_home_to_work_route")
    if "shift_details" in intents and active_job and not active_job.get("shift_start_time"):
        if "shift_start_end_times_not_verified" not in warnings:
            warnings.append("shift_start_end_times_not_verified")
    return {
        "schema_version": 1, "mode": "shadow_only",
        "action": action, "intents": intents,
        "context": {
            "residence_area": memory["residence_area"],
            "priority": memory["priority"],
            "messages_scanned": memory["messages_scanned"],
            "current_job_id": active_job.get("id") if active_job else None,
            "mentioned_place_keys": mentioned,
        },
        "crm_evidence": facts, "warnings": warnings,
        "next_question": next_question,
        "work_area_confirmed": False,
        "qualification_changed": False,
        "latency_ms": round((time.perf_counter() - t0) * 1000, 3),
    }
