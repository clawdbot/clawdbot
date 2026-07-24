"""Tests for provider-neutral execution models."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from tools.ai_intelligence.execution_models import (
    AttemptStatus,
    ExecutionAttempt,
    ExecutionModelError,
    ExecutionResult,
    ExecutionStatus,
    ProviderRequest,
    ProviderResponse,
)


START = datetime(
    2026,
    7,
    24,
    12,
    0,
    tzinfo=timezone.utc,
)

FINISH = START + timedelta(milliseconds=250)


class ProviderRequestTests(unittest.TestCase):
    def test_builds_valid_request(self) -> None:
        request = ProviderRequest(
            model_id="ollama-hermes3-8b",
            prompt="Summarize the property tasks.",
        )

        self.assertEqual(
            request.model_id,
            "ollama-hermes3-8b",
        )
        self.assertTrue(request.request_id)

    def test_rejects_blank_prompt(self) -> None:
        with self.assertRaises(ExecutionModelError):
            ProviderRequest(
                model_id="ollama-hermes3-8b",
                prompt=" ",
            )

    def test_rejects_invalid_timeout(self) -> None:
        with self.assertRaises(ExecutionModelError):
            ProviderRequest(
                model_id="ollama-hermes3-8b",
                prompt="Hello",
                timeout_seconds=0,
            )


class ExecutionAttemptTests(unittest.TestCase):
    def test_builds_successful_attempt(self) -> None:
        response = ProviderResponse(
            provider_name="ollama",
            model_id="ollama-hermes3-8b",
            content="Completed.",
            duration_ms=250,
        )

        attempt = ExecutionAttempt.success(
            response,
            started_at=START,
            finished_at=FINISH,
        )

        self.assertEqual(
            attempt.status,
            AttemptStatus.SUCCESS,
        )
        self.assertEqual(
            attempt.content,
            "Completed.",
        )

    def test_builds_failed_attempt(self) -> None:
        attempt = ExecutionAttempt.failure(
            provider_name="ollama",
            model_id="ollama-hermes3-8b",
            status=AttemptStatus.TIMEOUT,
            started_at=START,
            finished_at=FINISH,
            duration_ms=250,
            error=TimeoutError("timed out"),
        )

        self.assertEqual(
            attempt.status,
            AttemptStatus.TIMEOUT,
        )
        self.assertEqual(
            attempt.error_type,
            "TimeoutError",
        )

    def test_success_requires_content(self) -> None:
        with self.assertRaises(ExecutionModelError):
            ExecutionAttempt(
                provider_name="ollama",
                model_id="ollama-hermes3-8b",
                status=AttemptStatus.SUCCESS,
                started_at=START,
                finished_at=FINISH,
                duration_ms=250,
            )


class ExecutionResultTests(unittest.TestCase):
    def successful_attempt(self) -> ExecutionAttempt:
        return ExecutionAttempt(
            provider_name="ollama",
            model_id="ollama-hermes3-8b",
            status=AttemptStatus.SUCCESS,
            started_at=START,
            finished_at=FINISH,
            duration_ms=250,
            content="Answer",
        )

    def failed_attempt(self) -> ExecutionAttempt:
        return ExecutionAttempt(
            provider_name="ollama",
            model_id="ollama-gemma3-12b",
            status=AttemptStatus.UNAVAILABLE,
            started_at=START,
            finished_at=FINISH,
            duration_ms=250,
            error_type="ProviderUnavailableError",
            error_message="offline",
        )

    def test_builds_success_result(self) -> None:
        result = ExecutionResult(
            request_id="request-1",
            component_id="ranchbrain",
            status=ExecutionStatus.SUCCESS,
            attempts=(
                self.failed_attempt(),
                self.successful_attempt(),
            ),
            content="Answer",
            selected_model_id="ollama-hermes3-8b",
        )

        self.assertTrue(result.succeeded)

        self.assertEqual(
            result.attempted_model_ids,
            (
                "ollama-gemma3-12b",
                "ollama-hermes3-8b",
            ),
        )

    def test_builds_failed_result(self) -> None:
        result = ExecutionResult(
            request_id="request-1",
            component_id="ranchbrain",
            status=ExecutionStatus.FAILED,
            attempts=(self.failed_attempt(),),
        )

        self.assertTrue(result.failed)

    def test_success_rejects_mismatched_model(self) -> None:
        with self.assertRaises(ExecutionModelError):
            ExecutionResult(
                request_id="request-1",
                component_id="ranchbrain",
                status=ExecutionStatus.SUCCESS,
                attempts=(self.successful_attempt(),),
                content="Answer",
                selected_model_id="wrong-model",
            )


if __name__ == "__main__":
    unittest.main()
