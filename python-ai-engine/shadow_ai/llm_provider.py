"""Opt-in Groq-compatible inference for SYNTHETIC evaluation only.

Default has no network, no CRM credentials, no WhatsApp and no model costs.
The only built-in network destination is Groq's HTTPS chat-completions URL.
Never put applicant data in these synthetic tests.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

from .model_boundary import minimal_model_context

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
MAX_TOKENS = 180
MAX_CASES = 10
MIN_SECRET_LENGTH = 20
PHONE = re.compile(r"(?<!\d)(?:\+?20|0)?1[0125]\d{8}(?!\d)")
MODEL_ID = re.compile(r"^[a-zA-Z0-9_./-]{3,110}$")
PURPOSE = "Egyptian Arabic recruiting, SYNTHETIC fixtures only; read-only intent planning"


class DisabledNetwork(RuntimeError):
    """Opt-in protections refused a remote request."""


class ProviderCallError(RuntimeError):
    """Only safe status categories, never raw remote error bodies or credentials."""
    def __init__(self, status: str):
        self.status = status
        super().__init__("Provider request failed (" + status + ")")


@dataclass(frozen=True)
class EvaluationConfig:
    model: str
    token: str
    network_allowed: bool = False
    timeout_seconds: int = 12

    @classmethod
    def from_environment(cls, *, approved: bool = False) -> "EvaluationConfig":
        return cls(
            model=os.environ.get("SHADOW_GROQ_MODEL", "").strip(),
            token=os.environ.get("SHADOW_GROQ_API_KEY", ""),
            network_allowed=(approved and
                             os.environ.get("SHADOW_LLM_NETWORK_ENABLED") == "YES"),
        )

    def check(self) -> None:
        if not self.network_allowed:
            raise DisabledNetwork("Explicit user-approved network flag is required")
        if not MODEL_ID.fullmatch(self.model):
            raise DisabledNetwork("Valid model ID must be provided explicitly")
        if len(self.token) < MIN_SECRET_LENGTH:
            raise DisabledNetwork("Evaluation-only provider key not configured")


def _synthetic_turns(history: list[dict[str, Any]]) -> list[str]:
    texts = []
    for turn in history:
        if turn.get("role") in ("applicant", "user") and isinstance(turn.get("text"), str):
            text = turn["text"].strip()
            if len(text) > 550:
                raise ValueError("Synthetic utterance exceeds safety bound")
            texts.append(text)
    return texts


def checked_synthetic_context(baseline: dict[str, Any],
                              history: list[dict[str, Any]]) -> dict[str, Any]:
    """Only checked-in synthetic cases are eligible for this transport."""
    turns = _synthetic_turns(history)
    if not turns:
        raise ValueError("At least one synthetic utterance required")
    if len(history) > 80:
        raise ValueError("Large external conversation cannot be transmitted")
    for turn in turns:
        if PHONE.search(turn) or "رقمي" in turn or "رقم تليفوني" in turn:
            raise ValueError("Potential personal information in fixture")
    if sum(len(t) for t in turns) > 4400:
        raise ValueError("Synthetic conversation too long for provider test")
    # The previous structured context never includes candidate home address or
    # any transcript; only these synthetic text examples provide Arabic input.
    return {
        "purpose": PURPOSE,
        "synthetic_utterances": turns,
        "crm_and_policy": minimal_model_context(baseline),
    }


def request_payload(context: dict[str, Any], model: str) -> dict[str, Any]:
    return {
        "model": model, "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "response_format": {"type": "json_object"},
        # GPT-OSS does not accept reasoning_format. Groq supports the
        # mutually exclusive include_reasoning parameter for GPT-OSS.
        "include_reasoning": False,
        "reasoning_effort": "low",
        "messages": [
            {"role": "system", "content": (
                "أنت مختبر نوايا توظيف للغة العامية المصرية. الأمثلة افتراضية فقط. "
                "ارجع JSON فقط بمفاتيح action و confidence و reason_code. "
                "اختار فعل واحد من الأفعال المدعومة في سياق السياسة المعروض، "
                "ولا تؤكد أهلية متقدم أو منطقة عمل، ولا تتخيل راتباً أو مواعيد أو مسافة. "
                "لو مش متأكد اختار clarify_or_continue."
            )},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
        ],
    }


def _post_groq(payload: dict[str, Any], token: str, timeout: int) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(
        GROQ_URL, body, method="POST",
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json"},
    )
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read(15000)
    except HTTPError as error:
        # Only an HTTP status number is exposed. Never log response body,
        # exception strings, request headers or raw prompts.
        status = int(error.code) if 100 <= int(error.code) <= 599 else 0
        raise ProviderCallError("http_" + str(status)) from None
    except (URLError, TimeoutError, OSError):
        raise ProviderCallError("network_or_timeout") from None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        raise ProviderCallError("invalid_json_response") from None


class GroqSyntheticProposer:
    def __init__(self, config: EvaluationConfig,
                 transport: Callable[[dict[str, Any], str, int],
                                     dict[str, Any]] | None = None):
        self.config = config
        self.transport = transport or _post_groq
        self.last_usage: dict[str, int] = {}
        self.last_latency_ms: float | None = None
        self.request_count = 0

    def propose(self, *, baseline: dict[str, Any], history: list[dict[str, Any]]) -> Any:
        self.config.check()
        if self.request_count >= MAX_CASES:
            raise DisabledNetwork("Hard limit of 10 model requests per evaluation")
        context = checked_synthetic_context(baseline, history)
        payload = request_payload(context, self.config.model)
        # Increment before send, including errors, to bound all attempts.
        self.request_count += 1
        started = time.perf_counter()
        try:
            result = self.transport(payload, self.config.token,
                                    self.config.timeout_seconds)
            parsed = json.loads(result["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError, ValueError):
            raise RuntimeError("Unrecognized provider model proposal") from None
        finally:
            self.last_latency_ms = round((time.perf_counter() - started) * 1000, 2)
        usage = result.get("usage") if isinstance(result, dict) else {}
        usage = usage if isinstance(usage, dict) else {}
        self.last_usage = {
            name: max(0, min(20000, int(usage.get(name, 0) or 0)))
            for name in ("prompt_tokens", "completion_tokens", "total_tokens")
            if isinstance(usage.get(name, 0), (int, float))
        }
        if not isinstance(parsed, dict):
            raise RuntimeError("Provider proposal must be a JSON object")
        # Return unfiltered JSON. model_boundary MUST reject unexpected keys.
        return parsed
