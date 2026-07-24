"""Tests for the Gateway JSON bridge."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from tools.ai_intelligence.execution_models import (
    AttemptStatus,
    ExecutionAttempt,
    ExecutionResult,
    ExecutionStatus,
)
from tools.ai_intelligence.gateway_bridge import serialize_result


class GatewayBridgeTests(unittest.TestCase):
    def test_serialize_result_uses_gateway_field_names(self) -> None:
        timestamp = datetime(2026, 7, 24, tzinfo=timezone.utc)
        result = ExecutionResult(
            request_id="gateway-test",
            component_id="telegram_ranch_bot",
            status=ExecutionStatus.SUCCESS,
            attempts=(
                ExecutionAttempt(
                    provider_name="ollama",
                    model_id="ollama-gemma3-12b",
                    status=AttemptStatus.SUCCESS,
                    started_at=timestamp,
                    finished_at=timestamp,
                    duration_ms=1,
                    content="hello",
                ),
            ),
            content="hello",
            selected_model_id="ollama-gemma3-12b",
        )

        payload = serialize_result(result)

        self.assertEqual(payload["requestId"], "gateway-test")
        self.assertEqual(payload["componentId"], "telegram_ranch_bot")
        self.assertEqual(payload["attempts"][0]["status"], "success")
