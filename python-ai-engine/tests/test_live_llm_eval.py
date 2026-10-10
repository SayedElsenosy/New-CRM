import json
import unittest
import io
from unittest.mock import patch
from urllib.error import HTTPError

from shadow_ai.core import plan
from shadow_ai.evaluate import AREAS, user, preview
from shadow_ai.llm_provider import (
    DisabledNetwork, EvaluationConfig, GroqSyntheticProposer,
    checked_synthetic_context, request_payload, MAX_CASES,
    ProviderCallError, _post_groq, groq_permission_code
)
from shadow_ai.live_eval import run_synthetic, check_free_pilot, FREE_PILOT_CASE_IDS
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
        self.assertFalse(sent["include_reasoning"])
        self.assertEqual(sent["reasoning_effort"], "low")
        self.assertNotIn("reasoning_format", sent)
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

    def test_free_pilot_explicit_double_confirmation_and_model(self):
        self.assertEqual(FREE_PILOT_CASE_IDS,
                         ("ad_vehicle", "income_vs_commute", "history_50"))
        with self.assertRaises(DisabledNetwork):
            check_free_pilot(config(True), approved_in_console=False, free_tier_env="YES")
        with self.assertRaises(DisabledNetwork):
            check_free_pilot(config(True), approved_in_console=True, free_tier_env="")
        with self.assertRaises(DisabledNetwork):
            check_free_pilot(EvaluationConfig(model="other-model", token=KEY,
                                              network_allowed=True),
                             approved_in_console=True, free_tier_env="YES")
        valid = EvaluationConfig(model="openai/gpt-oss-20b", token=KEY,
                                 network_allowed=True)
        check_free_pilot(valid, approved_in_console=True, free_tier_env="YES")

    def test_free_pilot_hard_capped_at_three_without_transport(self):
        with self.assertRaises(ValueError):
            run_synthetic(config(True), max_cases=4,
                          proposer=GroqSyntheticProposer(config(True),
                                                         transport=lambda *a: self.fail("Network attempted")))

    def test_three_cases_are_curated_not_just_first_three(self):
        def fake(payload, token, timeout):
            return {"choices": [{"message": {"content": json.dumps({
                "action": "clarify_or_continue", "confidence": 0.85,
                "reason_code": "test"
            })}}], "usage": {"prompt_tokens": 50, "completion_tokens": 12}}
        pilot = GroqSyntheticProposer(config(True), transport=fake)
        report = run_synthetic(config(True), max_cases=3, proposer=pilot)
        self.assertEqual([c["id"] for c in report["cases"]], list(FREE_PILOT_CASE_IDS))
        self.assertEqual(report["live_llm_requests_attempted"], 3)
        self.assertEqual(report["total_prompt_tokens"], 150)

    def test_http_400_is_reported_without_exposing_unsafe_response(self):
        http_error = HTTPError("https://api.groq.com", 400,
                               "TOKEN=SECRET from groq", {}, None)
        with patch("shadow_ai.llm_provider.urlopen", side_effect=http_error):
            with self.assertRaises(ProviderCallError) as context:
                _post_groq({"test": True}, KEY, 12)
        self.assertEqual(context.exception.status, "http_400")
        self.assertNotIn("SECRET", str(context.exception))

    def test_restricted_org_or_project_returns_safe_permission_code(self):
        for code in ("model_permission_blocked_org", "model_permission_blocked_project"):
            with self.subTest(code=code):
                body = json.dumps({"error": {
                    "code": code,
                    "message": "API key SECRET, user phone 01000000000"
                }}).encode("utf-8")
                http_error = HTTPError("https://api.groq.com", 403,
                                       "PRIVATE", {}, io.BytesIO(body))
                with patch("shadow_ai.llm_provider.urlopen", side_effect=http_error):
                    with self.assertRaises(ProviderCallError) as raised:
                        _post_groq({"test": True}, KEY, 12)
                self.assertEqual(raised.exception.status, "http_403")
                self.assertEqual(raised.exception.permission_code, code)
                self.assertNotIn("SECRET", str(raised.exception))
                self.assertNotIn("PRIVATE", str(raised.exception))

    def test_untrusted_provider_codes_and_messages_never_leave_error(self):
        for body in [
            b'{"error":{"code":"secret-USER-AND-KEY-123","message":"PRIVATE"}}',
            b'not-json',
            b'{"error":{"code":"model_permission_blocked_org","message":"PRIVATE"}}' * 200,
        ]:
            with self.subTest(size=len(body)):
                http_error = HTTPError("https://api.groq.com", 403,
                                       "PRIVATE", {}, io.BytesIO(body))
                with patch("shadow_ai.llm_provider.urlopen", side_effect=http_error):
                    with self.assertRaises(ProviderCallError) as raised:
                        _post_groq({"test": True}, KEY, 12)
                self.assertIsNone(raised.exception.permission_code)
                self.assertNotIn("PRIVATE", str(raised.exception))
                self.assertNotIn("secret-", str(raised.exception))

    def test_permission_code_survives_in_sanitized_single_attempt_report(self):
        attempts = []
        def blocked(*args):
            attempts.append(1)
            raise ProviderCallError(
                "http_403", permission_code="model_permission_blocked_project")
        proposer = GroqSyntheticProposer(config(True), transport=blocked)
        report = run_synthetic(config(True), max_cases=3, proposer=proposer)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(report["cases_evaluated"], 1)
        self.assertEqual(report["cases"][0]["provider_error_status"], "http_403")
        self.assertEqual(report["cases"][0]["provider_permission_code"],
                         "model_permission_blocked_project")
        self.assertNotIn(KEY, json.dumps(report))

    def test_first_provider_failure_stops_without_three_wasted_calls(self):
        requests = []
        def broken(payload, token, timeout):
            requests.append("attempt")
            raise ProviderCallError("http_400")
        proposer = GroqSyntheticProposer(config(True), transport=broken)
        report = run_synthetic(config(True), max_cases=3, proposer=proposer)
        self.assertEqual(report["cases_evaluated"], 1)
        self.assertEqual(report["live_llm_requests_attempted"], 1)
        self.assertEqual(report["provider_errors"], 1)
        self.assertEqual(report["cases"][0]["provider_error_status"], "http_400")
        self.assertEqual(report["model_only_evaluable_cases"], 0)
        self.assertEqual(report["model_only_matches_reference"], 0)
        self.assertEqual(report["action_matches_reference"], 1)
        self.assertEqual(len(requests), 1)
        self.assertNotIn(KEY, json.dumps(report))

    def test_llm_success_is_counted_separately_from_rule_fallbacks(self):
        def fake(payload, token, timeout):
            return {"choices": [{"message": {"content": json.dumps({
                "action": "clarify_job_system", "confidence": .92,
                "reason_code": "job_missing"
            })}}], "usage": {"prompt_tokens": 55, "completion_tokens": 16}}
        pilot = GroqSyntheticProposer(config(True), transport=fake)
        result = run_synthetic(config(True), max_cases=1, proposer=pilot)
        self.assertEqual(result["model_only_evaluable_cases"], 1)
        self.assertEqual(result["model_only_matches_reference"], 1)
        self.assertEqual(result["provider_errors"], 0)
        self.assertEqual(result["model_proposals_accepted"], 1)

if __name__ == "__main__":
    unittest.main()
