"""Comparable input, intentionally distinct contracts: Python produces plans,
Node produces user replies. Scores MUST NOT be directly ranked as AI IQ."""
from __future__ import annotations

import argparse
import json
import subprocess
import statistics
from pathlib import Path

from .core import plan

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "python-ai-engine" / "benchmarks" / "paired_cases.json"
NODE_SCRIPT = ROOT / "python-ai-engine" / "benchmarks" / "run_node.mjs"


def fixture_data(path: Path = FIXTURES) -> dict:
    dataset = json.loads(path.read_text(encoding="utf-8"))
    if dataset.get("version") != 1 or not isinstance(dataset.get("cases"), list):
        raise ValueError("invalid paired fixture version")
    if not dataset["cases"] or len(dataset["cases"]) > 100:
        raise ValueError("invalid case count")
    if len({row["id"] for row in dataset["cases"]}) != len(dataset["cases"]):
        raise ValueError("duplicate case ID")
    return dataset


def python_results(dataset: dict) -> list[dict]:
    results = []
    areas = dataset["areas"]
    for item in dataset["cases"]:
        expectations = item.get("expect") or {}
        try:
            result = plan({"history": item["history"], "areas": areas})
            checks = []
            def check(key, value):
                checks.append({"check": key, "pass": bool(value)})
            if "python_action" in expectations:
                check("expected_action", result["action"] == expectations["python_action"])
            for intent in expectations.get("python_intents", []):
                check("intent:" + intent, intent in result["intents"])
            for intent in expectations.get("python_absent_intents", []):
                check("excluded_intent:" + intent, intent not in result["intents"])
            for warning in expectations.get("python_warnings", []):
                check("safety:" + warning, warning in result["warnings"])
            if "python_residence" in expectations:
                check("historical_residence",
                      result["context"]["residence_area"] == expectations["python_residence"])
            check("never_mutates_qualification", result["qualification_changed"] is False)
            check("no_implicit_area_confirmation", result["work_area_confirmed"] is False)
            check("full_supplied_history_scanned",
                  result["context"]["messages_scanned"] == len(item["history"]))
            results.append({"id": item["id"], "action": result["action"],
                            "elapsed_ms": result["latency_ms"], "checks": checks,
                            "passed": sum(x["pass"] for x in checks),
                            "total": len(checks)})
        except (TypeError, ValueError, KeyError, AttributeError) as error:
            results.append({"id": item["id"], "action": "error", "elapsed_ms": None,
                            "passed": 0, "total": 1,
                            "checks": [{"check": "executed", "pass": False}],
                            "error_type": type(error).__name__})
    return results


def paired_report(dataset: dict, node: list[dict] | None = None) -> dict:
    py = python_results(dataset)
    by_id = {row["id"]: row for row in node or []}
    rows = []
    for p in py:
        n = by_id.get(p["id"])
        rows.append({
            "id": p["id"],
            "python": {"action": p["action"], "passed": p["passed"],
                       "checks": p["total"], "latency_ms": p["elapsed_ms"],
                       "failed_checks": [c["check"] for c in p["checks"] if not c["pass"]]},
            "node": None if n is None else {
                "action": n["action"], "passed": n["passed"], "checks": n["total"],
                "latency_ms": n["elapsed_ms"],
                "failed_checks": [c["check"] for c in n["checks"] if not c["pass"]],
            },
        })
    def summary(key):
        samples = [r[key] for r in rows if r[key] is not None]
        durations = [r["latency_ms"] for r in samples if r["latency_ms"] is not None]
        return {"cases": len(samples),
                "checks_passed": sum(r["passed"] for r in samples),
                "checks_total": sum(r["checks"] for r in samples),
                "case_contracts_passed": sum(r["passed"] == r["checks"] for r in samples),
                "median_ms": round(statistics.median(durations), 3) if durations else None}
    return {
        "scope": "SYNTHETIC, OFFLINE, NO LLM; Python structured-plan and Node user-reply checks are DIFFERENT contracts",
        "note": "Never compare passed/total or runtime across languages as model IQ or total WhatsApp latency.",
        "fixtures": len(rows),
        "python": summary("python"), "node": summary("node"),
        "cases": rows
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python-only", action="store_true")
    parser.add_argument("--fail-on-python", action="store_true")
    arguments = parser.parse_args()
    dataset = fixture_data()
    node = None
    if not arguments.python_only:
        completed = subprocess.run(["node", str(NODE_SCRIPT), str(FIXTURES)],
                                   cwd=ROOT, capture_output=True, text=True,
                                   timeout=90, check=True)
        response = json.loads(completed.stdout)
        if response.get("engine") != "node-production-flow-offline":
            raise RuntimeError("unrecognized Node evaluation")
        node = response["cases"]
        if {row["id"] for row in node} != {row["id"] for row in dataset["cases"]}:
            raise RuntimeError("case IDs do not match")
    report = paired_report(dataset, node)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if arguments.fail_on_python and report["python"]["case_contracts_passed"] < report["fixtures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
