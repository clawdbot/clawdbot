"""Tests for AI execution usage and failover telemetry."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Any

from tools.ai_intelligence.execution_engine import (
    ExecutionEngine,
    ExecutionEngineConfigurationError,
)
from tools.ai_intelligence.execution_models import (
    AttemptStatus,
    ExecutionAttempt,
    ExecutionResult,
    ExecutionStatus,
    ProviderResponse,
)
from tools.ai_intelligence.provider import (
    ProviderUnavailableError,
)
from tools.ai_intelligence.routing_models import (
    AssignmentType,
    FallbackChain,
    ModelAssignment,
    PrivacyTier,
    RoutingDecision,
    RoutingMode,
    RoutingRequest,
)
from tools.ai_intelligence.telemetry import (
    build_observed_usage_record,
    format_failover_status_text,
    summarize_failover_status,
)


def assignment(
    *,
    model_id: str,
    assignment_type: AssignmentType,
    priority: int,
) -> ModelAssignment:
    return ModelAssignment(
        component_id="telegram_ranch_bot",
        component_name="Telegram Ranch Bot",
        component_privacy_tier=PrivacyTier.LOCAL,
        task_type="conversation",
        assignment_type=assignment_type,
        priority=priority,
        model_id=model_id,
        model_name=model_id,
        provider="ollama",
        deployment="local",
        model_status="production",
        routing_mode=RoutingMode.PRODUCTION_SAFE,
        human_approved=True,
    )


def decision() -> RoutingDecision:
    request = RoutingRequest(
        component_id="telegram_ranch_bot",
        request_id="telemetry-1",
    )
    return RoutingDecision(
        request=request,
        component_name="Telegram Ranch Bot",
        task_type="conversation",
        privacy_tier=PrivacyTier.LOCAL,
        routing_mode=RoutingMode.PRODUCTION_SAFE,
        chain=FallbackChain(
            primary=assignment(
                model_id="ollama-hermes3-8b",
                assignment_type=AssignmentType.PRIMARY,
                priority=1,
            ),
            fallbacks=(
                assignment(
                    model_id="ollama-llama3.2-3b",
                    assignment_type=AssignmentType.FALLBACK,
                    priority=1,
                ),
            ),
        ),
    )


class FakeProvider:
    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.requests: list[Any] = []

    @property
    def name(self) -> str:
        return "ollama"

    def supports_model(self, model_id: str) -> bool:
        return True

    def execute(self, request: Any) -> ProviderResponse:
        self.requests.append(request)
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeRouter:
    def __init__(self, value: RoutingDecision | None = None) -> None:
        self._value = value or decision()
        self.route_calls = 0

    def route(self, request: Any) -> RoutingDecision:
        self.route_calls += 1
        return self._value


class FakeProviderRegistry:
    def __init__(
        self,
        providers: dict[str, FakeProvider] | None = None,
    ) -> None:
        self._providers = providers or {}
        self.get_provider_calls = 0

    def get_provider(self, model_id: str) -> FakeProvider:
        self.get_provider_calls += 1
        if model_id not in self._providers:
            raise ProviderUnavailableError(f"missing {model_id}")
        return self._providers[model_id]


class RecordingTelemetry:
    def __init__(self) -> None:
        self.calls: list[tuple[RoutingDecision, ExecutionResult]] = []

    def record(
        self,
        decision: RoutingDecision,
        result: ExecutionResult,
    ) -> None:
        self.calls.append((decision, result))


class FailingTelemetry:
    def record(
        self,
        decision: RoutingDecision,
        result: ExecutionResult,
    ) -> None:
        raise RuntimeError("telemetry unavailable")


class TelemetryModelTests(unittest.TestCase):
    def test_builds_failover_observation(self) -> None:
        started = datetime(2026, 7, 25, tzinfo=timezone.utc)
        finished = datetime(2026, 7, 25, 0, 0, 1, tzinfo=timezone.utc)
        result = ExecutionResult(
            request_id="telemetry-1",
            component_id="telegram_ranch_bot",
            status=ExecutionStatus.SUCCESS,
            attempts=(
                ExecutionAttempt(
                    provider_name="ollama",
                    model_id="ollama-hermes3-8b",
                    status=AttemptStatus.UNAVAILABLE,
                    started_at=started,
                    finished_at=finished,
                    duration_ms=10,
                    error_type="ProviderUnavailableError",
                    error_message="Ollama returned HTTP 404",
                ),
                ExecutionAttempt.success(
                    ProviderResponse(
                        provider_name="ollama",
                        model_id="ollama-llama3.2-3b",
                        content="FALLBACK_OK",
                        duration_ms=20,
                    ),
                    started_at=started,
                    finished_at=finished,
                ),
            ),
            content="FALLBACK_OK",
            selected_model_id="ollama-llama3.2-3b",
        )

        record = build_observed_usage_record(decision(), result)

        self.assertEqual(record.model_id, "ollama-llama3.2-3b")
        self.assertEqual(record.selected_as, "fallback")
        self.assertTrue(record.success)
        self.assertTrue(record.usage_metadata["failover_occurred"])
        self.assertEqual(
            record.usage_metadata["configured_primary_model_id"],
            "ollama-hermes3-8b",
        )
        self.assertEqual(record.usage_metadata["attempt_count"], 2)

    def test_summary_reports_drift_and_failover(self) -> None:
        summary = summarize_failover_status(
            drift_rows=[
                {
                    "component_id": "telegram_ranch_bot",
                    "configured_primary_model": "ollama-hermes3-8b",
                    "latest_observed_model": "ollama-llama3.2-3b",
                    "deployment_status": "drift",
                    "observed_at": "2026-07-25T00:00:00+00:00",
                }
            ],
            recent_rows=[
                {
                    "component_id": "telegram_ranch_bot",
                    "model_id": "ollama-llama3.2-3b",
                    "selected_as": "fallback",
                    "success": True,
                    "request_id": "telemetry-1",
                    "observed_at": "2026-07-25T00:00:00+00:00",
                    "usage_metadata": {"failover_occurred": True},
                }
            ],
        )

        self.assertEqual(summary["status"], "attention")
        self.assertEqual(
            summary["configured_versus_observed"]["drift"],
            1,
        )
        self.assertEqual(summary["recent_failover_count"], 1)
        text = format_failover_status_text(summary)
        self.assertIn("AI Routing Telemetry", text)
        self.assertIn("drift=1", text)


class ExecutionTelemetryIntegrationTests(unittest.TestCase):
    def test_records_successful_execution(self) -> None:
        recorder = RecordingTelemetry()
        provider = FakeProvider(
            [
                ProviderResponse(
                    provider_name="ollama",
                    model_id="ollama-hermes3-8b",
                    content="OK",
                    duration_ms=5,
                )
            ]
        )
        engine = ExecutionEngine(
            FakeRouter(),
            FakeProviderRegistry({"ollama-hermes3-8b": provider}),
            telemetry_recorder=recorder,
        )

        result = engine.execute(
            RoutingRequest(
                component_id="telegram_ranch_bot",
                request_id="telemetry-1",
            ),
            prompt="hello",
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(len(recorder.calls), 1)
        self.assertEqual(
            recorder.calls[0][1].selected_model_id,
            "ollama-hermes3-8b",
        )

    def test_telemetry_failure_does_not_block_response(self) -> None:
        provider = FakeProvider(
            [
                ProviderResponse(
                    provider_name="ollama",
                    model_id="ollama-hermes3-8b",
                    content="OK",
                    duration_ms=5,
                )
            ]
        )
        engine = ExecutionEngine(
            FakeRouter(),
            FakeProviderRegistry({"ollama-hermes3-8b": provider}),
            telemetry_recorder=FailingTelemetry(),
        )

        result = engine.execute(
            RoutingRequest(
                component_id="telegram_ranch_bot",
                request_id="telemetry-1",
            ),
            prompt="hello",
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(result.content, "OK")

    def test_rejects_invalid_telemetry_recorder(self) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            r"^telemetry_recorder must implement "
            r"record\(decision, result\)$",
        ):
            ExecutionEngine(
                FakeRouter(),
                FakeProviderRegistry(),
                telemetry_recorder=object(),  # type: ignore[arg-type]
            )


if __name__ == "__main__":
    unittest.main()
