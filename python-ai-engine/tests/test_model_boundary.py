import json
import unittest

from shadow_ai.model_boundary import (
    minimal_model_context, plan_with_optional_model, safe_model_action
)
from shadow_ai.evaluate import AREAS, user, preview


class ModelBoundaryTests(unittest.TestCase):
    def payload(self):
        return {
            "history": [
                user("أنا ساكن في المنصورية ورقمي 01000000000"),
                preview("obour-market"),
                user("طيب شفت العبور كام ساعة؟")
            ],
            "areas": AREAS
        }

    def test_disabled_does_not_call_model(self):
        def fail(context):
            self.fail("Disabled provider should never run")
        result = plan_with_optional_model(self.payload(), model=fail, enabled=False)
        self.assertFalse(result["model_used"])
        self.assertFalse(result["qualification_changed"])
        self.assertFalse(result["work_area_confirmed"])

    def test_allowed_proposal_does_not_mutate_qualification_or_evidence(self):
        seen = []
        def fake_model(context):
            seen.append(context)
            return {"action": "answer_shift_from_crm", "confidence": .94,
                    "reason_code": "grounded_shift"}
        result = plan_with_optional_model(self.payload(), model=fake_model, enabled=True)
        self.assertEqual(result["action"], "answer_shift_from_crm")
        self.assertTrue(result["model_proposal_accepted"])
        self.assertFalse(result["work_area_confirmed"])
        self.assertFalse(result["qualification_changed"])
        self.assertEqual(result["context"]["current_job_id"], "obour-market")
        self.assertEqual(result["crm_evidence"][0]["shift_hours"], 9)
        data = json.dumps(seen, ensure_ascii=False)
        self.assertNotIn("01000000000", data)
        self.assertNotIn("أنا ساكن", data)
        self.assertNotIn("text", data)

    def test_model_cannot_approve_hire_or_choose_area(self):
        for action in ("approve_candidate", "reject_candidate", "confirm_work_area",
                       "save_facts", "send_whatsapp", "qualified_candidate"):
            with self.subTest(action=action):
                result = plan_with_optional_model(
                    self.payload(), enabled=True,
                    model=lambda ctx: {"action": action, "confidence": .99}
                )
                self.assertFalse(result["model_proposal_accepted"])
                self.assertFalse(result["work_area_confirmed"])
                self.assertFalse(result["qualification_changed"])
                self.assertEqual(result["model_fallback"], "rejected")

    def test_fake_model_cannot_invent_unrelated_intent(self):
        result = plan_with_optional_model(
            self.payload(), enabled=True,
            model=lambda ctx: {"action": "compare_registered_jobs", "confidence": .99}
        )
        self.assertFalse(result["model_proposal_accepted"])
        self.assertEqual(result["action"], "answer_shift_from_crm")

    def test_provider_error_falls_back_without_exception_text(self):
        def broken(ctx):
            raise RuntimeError("A secret provider token 123")
        result = plan_with_optional_model(self.payload(), enabled=True, model=broken)
        self.assertEqual(result["model_fallback"], "provider_error")
        self.assertEqual(result["action"], "answer_shift_from_crm")
        self.assertNotIn("secret provider", json.dumps(result))

    def test_model_cannot_produce_published_unknown_job_information(self):
        base = {"intents": ["shift_details"], "context": {"current_job_id": None}}
        proposal = {"action": "answer_shift_from_crm", "confidence": .98}
        self.assertIsNone(safe_model_action(proposal, base))

    def test_extra_untrusted_keys_rejected(self):
        base = {"intents": ["shift_details"], "context": {"current_job_id": "obour-market"}}
        extra = {"action": "answer_shift_from_crm", "confidence": .99,
                 "reply": "يبدأ الشغل الساعة 8 صباحا"}
        self.assertIsNone(safe_model_action(extra, base))

if __name__ == "__main__":
    unittest.main()
