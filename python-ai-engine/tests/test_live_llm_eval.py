import json
import unittest

from shadow_ai.core import plan
from shadow_ai.evaluate import AREAS, user, preview
from shadow_ai.llm_provider import (
    DisabledNetwork, EvaluationConfig, GroqSyntheticProposer,
    checked_synthetic_context, request_payload, MAX_CASES
)
from shadow_ai.live_eval import run_synthetic
from shadow_ai.model_boundary import safe_model_action

EXAMPLE = {"history": [user("ممكن أعرف شيفت العبور كام ساعة؟"),
                       preview("obour-market"),
                       user("الشيفت كام ساعة؟")], "areas": AREAS}
KEY = "only-for-unit-testing-this-is-not-a-real-api-key"


def config(allowed=False):
    return EvaluationConfig(model="test-synthetic-model", token=KEY,
                            network_allowed=allowed)


class LiveLLMSafetyTests(unittest.TestCase):
    def test_no_network_without_two_explicit_flags(self):
        hit = []
        def fake(payload, token, timeout):
            hit.append(payload)
            return {}
        proposer = GroqSyntheticProposer(config(False), transport=fake)
        with self.assertRaises(DisabledNetwork):
            proposer.propose(baseline=plan(EXAMPLE), history=EXAMPLE["history"])
        self.assertFalse(hit)
        self.assertEqual(proposer.request_count, 0)

    def test_missing_model_and_key_rejected(self):
        for cfg in (EvaluationConfig(model="", token=KEY, network_allowed=True),
                    EvaluationConfig(model="test-model", token="", network_allowed=True),
                    EvaluationConfig(model="../evil?model", token=KEY, network_allowed=True)):
            with self.subTest(model=cfg.model):
                with self.assertRaises(DisabledNetwork):
                    cfg.check()

    def test_synthetic_payload_only_and_usage_captured(self):
        requests = []
        def fake(payload, token, timeout):
            requests.append((payload, token, timeout))
            return {"choices": [{"message": {"content": json.dumps({
                "action": "answer_shift_from_crm", "confidence": .95,
                "reason_code": "registered_shift"
            })}}],
                "usage": {"prompt_tokens": 120, "completion_tokens": 22, "total_tokens": 142}}
        p = GroqSyntheticProposer(config(True), transport=fake)
        baseline = plan(EXAMPLE)
        suggestion = p.propose(baseline=baseline, history=EXAMPLE["history"])
        self.assertEqual(safe_model_action(suggestion, baseline), "answer_shift_from_crm")
        sent = requests[0][0]
        self.assertEqual(sent["model"], "test-synthetic-model")
        self.assertEqual(sent["max_tokens"], 180)
        self.assertEqual(sent["temperature"], 0)
        self.assertEqual(sent["response_format"]["type"], "json_object")
        self.assertEqual(p.last_usage["total_tokens"], 142)
        self.assertEqual(p.request_count, 1)
        self.assertNotIn("01000000000", json.dumps(sent, ensure_ascii=False))

    def test_pii_cannot_be_sent_even_with_network_enabled(self):
        history = [user("أنا صاحب رقم 01000000000"), user("فين الشغل")]
        fake_calls = []
        proposer = GroqSyntheticProposer(config(True),
                                         transport=lambda *x: fake_calls.append(x))
        with self.assertRaises(ValueError):
            proposer.propose(baseline=plan({"history": history, "areas": AREAS}),
                             history=history)
        self.assertFalse(fake_calls)
        self.assertEqual(proposer.request_count, 0)

    def test_arbitrary_full_chat_and_long_payload_rejected(self):
        baseline = plan(EXAMPLE)
        with self.assertRaises(ValueError):
            checked_synthetic_context(baseline, [user("كلام افتراضي")] * 81)
        with self.assertRaises(ValueError):
            checked_synthetic_context(baseline, [user("مرحبا " * 800)])

    def test_provider_attempt_limit_including_invalid_response(self):
        attempts = []
        def fake(*args):
            attempts.append(1)
            return {"choices": [{"message": {"content": '{"action":"not_allowed"}'}}]}
        p = GroqSyntheticProposer(config(True), transport=fake)
        for _ in range(MAX_CASES):
            p.propose(baseline=plan(EXAMPLE), history=EXAMPLE["history"])
        with self.assertRaises(DisabledNetwork):
            p.propose(baseline=plan(EXAMPLE), history=EXAMPLE["history"])
        self.assertEqual(len(attempts), MAX_CASES)

    def test_excess_json_fields_are_rejected_by_original_safety_gate(self):
        p = GroqSyntheticProposer(config(True), transport=lambda *args: {
            "choices": [{"message": {"content": json.dumps({
                "action": "answer_shift_from_crm", "confidence": .99,
                "reply": "يبدأ الشيفت الساعة 8 الصبح"
            })}}]})
        baseline = plan(EXAMPLE)
        proposal = p.propose(baseline=baseline, history=EXAMPLE["history"])
        self.assertIsNone(safe_model_action(proposal, baseline))

    def test_invalid_provider_payload_fails_without_echoing_response(self):
        p = GroqSyntheticProposer(config(True), transport=lambda *args: {
            "choices": [{"message": {"content": "MY SECRET KEY foo"}}]})
        with self.assertRaises(RuntimeError) as context:
            p.propose(baseline=plan(EXAMPLE), history=EXAMPLE["history"])
        self.assertNotIn("SECRET", str(context.exception))

    def test_live_report_with_mock_only(self):
        def fake(payload, token, timeout):
            return {"choices": [{"message": {"content": json.dumps({
                "action": "clarify_job_system", "confidence": 0.93,
                "reason_code": "unknown_job"
            })}}],
            "usage": {"prompt_tokens": 80, "completion_tokens": 15}}
        proposer = GroqSyntheticProposer(config(True), transport=fake)
        report = run_synthetic(config(True), max_cases=1, proposer=proposer)
        self.assertEqual(report["cases_evaluated"], 1)
        self.assertEqual(report["live_llm_requests_attempted"], 1)
        self.assertEqual(report["model_proposals_accepted"], 1)
        self.assertEqual(report["total_prompt_tokens"], 80)
        self.assertNotIn("موتوسيكل ولا عربية", json.dumps(report, ensure_ascii=False))

if __name__ == "__main__":
    unittest.main()
