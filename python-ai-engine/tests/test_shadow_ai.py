import json
import unittest

from shadow_ai.core import normalize, plan, MAX_MESSAGES
from shadow_ai.evaluate import AREAS, CASES, check_case, evaluate, user, preview


class ShadowPlannerTests(unittest.TestCase):
    def test_every_synthetic_scenario(self):
        for case in CASES:
            with self.subTest(name=case["name"]):
                passed, issues, result = check_case(case)
                self.assertTrue(passed, issues)
                self.assertEqual(result["mode"], "shadow_only")
                self.assertFalse(result["qualification_changed"])
                self.assertFalse(result["work_area_confirmed"])

    def test_complete_historical_index_not_recent_window(self):
        history = [user("أنا ساكن في المنصورية")]
        history += [user("رسالة قديمة") for _ in range(205)]
        history.extend([preview("obour-market"), user("الشفت كام ساعة")])
        result = plan({"history": history, "areas": AREAS})
        self.assertEqual(result["context"]["messages_scanned"], len(history))
        self.assertEqual(result["context"]["residence_area"], "المنصوريه")
        self.assertEqual(result["context"]["current_job_id"], "obour-market")

    def test_never_leaks_message_text_or_phone(self):
        # A number is present only inside the raw input. No raw transcript,
        # AI chain-of-thought or phone should be echoed by the planner.
        data = {"history": [user("رقمي 01000000000"),
                            preview("obour-market"),
                            user("الشيفت كام ساعة؟")], "areas": AREAS}
        result = plan(data)
        public = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("01000000000", public)
        self.assertNotIn("رقمي", public)
        self.assertEqual(result["action"], "answer_shift_from_crm")

    def test_stated_residence_never_confirms_work_region(self):
        data = {"history": [user("ساكن في العبور")], "areas": AREAS}
        result = plan(data)
        self.assertFalse(result["work_area_confirmed"])
        self.assertFalse(result["qualification_changed"])
        self.assertNotIn("work_area_proposal", result["intents"])

    def test_monthly_is_not_ranked_against_weekly(self):
        result = plan({
            "history": [user("الهرم ولا الشيخ زايد أحسن في المرتب؟")],
            "areas": AREAS})
        self.assertIn("do_not_compare_weekly_and_monthly_income",
                      result["warnings"])
        self.assertFalse(any("winner" in k for k in result))
        self.assertEqual(len(result["crm_evidence"]), 2)

    def test_delivery_zone_not_claimed_to_be_commute(self):
        result = plan({
            "history": [user("الهرم ولا الشيخ زايد أقرب لبيتي؟")],
            "areas": AREAS})
        self.assertIn("delivery_zone_is_not_home_commute",
                      result["warnings"])
        self.assertNotIn("distance_km_from_home", result)

    def test_skip_inactive_job(self):
        areas = [dict(AREAS[2], active=False)]
        result = plan({"history": [user("العبور الشفت كام")], "areas": areas})
        self.assertIsNone(result["context"]["current_job_id"])
        self.assertEqual(result["action"], "clarify_job_system")

    def test_invalid_schema_is_rejected(self):
        for value in (None, [], {}, {"history": "not an array"},
                      {"history": [user("x")] * (MAX_MESSAGES + 1)}):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ValueError):
                    plan(value)

    def test_normalization_dialect(self):
        self.assertEqual(normalize("  إيه مَواعيد الشُّغل ؟  "), "ايه مواعيد الشغل")
        self.assertEqual(normalize("٩ ساعات"), "9 ساعات")

    def test_offline_evaluation_has_no_silent_failures(self):
        report = evaluate()
        self.assertEqual(report["passed"], len(CASES))
        self.assertEqual(report["failed_cases"], [])
        self.assertGreaterEqual(report["median_ms"], 0)


if __name__ == "__main__":
    unittest.main()
