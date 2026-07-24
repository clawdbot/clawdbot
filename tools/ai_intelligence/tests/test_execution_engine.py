"""Tests for the AI execution engine foundation."""

from __future__ import annotations

import unittest
from dataclasses import replace
from typing import Any

from tools.ai_intelligence.execution_engine import (
    ExecutionEngine,
    ExecutionEngineConfigurationError,
)
from tools.ai_intelligence.execution_models import (
    AttemptStatus,
    ProviderRequest,
    ProviderResponse,
)
from tools.ai_intelligence.provider import (
    AIProvider,
    InvalidProviderResponseError,
    ProviderError,
    ProviderTimeoutError,
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


def assignment(
    *,
    model_id: str,
    assignment_type: AssignmentType,
    priority: int,
) -> ModelAssignment:
    return ModelAssignment(
        component_id="ranchbrain",
        component_name="RanchBrain",
        component_privacy_tier=PrivacyTier.LOCAL,
        task_type="knowledge",
        assignment_type=assignment_type,
        priority=priority,
        model_id=model_id,
        model_name=model_id,
        provider="ollama",
        deployment="local",
        model_status="active",
        routing_mode=RoutingMode.PRODUCTION_SAFE,
        human_approved=True,
    )


def decision(
    request: RoutingRequest,
) -> RoutingDecision:
    return RoutingDecision(
        request=request,
        component_name="RanchBrain",
        task_type="knowledge",
        privacy_tier=PrivacyTier.LOCAL,
        routing_mode=RoutingMode.PRODUCTION_SAFE,
        chain=FallbackChain(
            primary=assignment(
                model_id="ollama-primary",
                assignment_type=AssignmentType.PRIMARY,
                priority=1,
            ),
            fallbacks=(
                assignment(
                    model_id="ollama-fallback-1",
                    assignment_type=AssignmentType.FALLBACK,
                    priority=1,
                ),
                assignment(
                    model_id="ollama-fallback-2",
                    assignment_type=AssignmentType.FALLBACK,
                    priority=2,
                ),
            ),
        ),
    )


class FakeRouter:
    def __init__(
        self,
        routing_decision: RoutingDecision | None = None,
    ) -> None:
        self.route_calls = 0
        self.routing_decision = routing_decision

    def route(
        self,
        request: RoutingRequest,
    ) -> RoutingDecision:
        self.route_calls += 1

        if self.routing_decision is None:
            raise AssertionError(
                "constructor must not route requests"
            )

        return replace(
            self.routing_decision,
            request=request,
        )


class FakeProviderRegistry:
    def __init__(
        self,
        providers: dict[str, AIProvider] | None = None,
    ) -> None:
        self.get_provider_calls = 0
        self.providers = providers or {}

    def get_provider(
        self,
        model_id: str,
    ) -> AIProvider:
        self.get_provider_calls += 1

        try:
            return self.providers[model_id]
        except KeyError as exc:
            raise ProviderUnavailableError(
                f"No provider for {model_id}"
            ) from exc


class FakeProvider:
    name = "ollama"

    def __init__(
        self,
        outcomes: list[ProviderResponse | Exception],
    ) -> None:
        self.outcomes = outcomes
        self.requests: list[ProviderRequest] = []

    def supports_model(self, model_id: str) -> bool:
        return True

    def execute(
        self,
        request: ProviderRequest,
    ) -> ProviderResponse:
        self.requests.append(request)
        outcome = self.outcomes.pop(0)

        if isinstance(outcome, Exception):
            raise outcome

        return outcome


def response(
    model_id: str,
    content: str = "Answer",
) -> ProviderResponse:
    return ProviderResponse(
        provider_name="ollama",
        model_id=model_id,
        content=content,
        duration_ms=5,
    )


class NonCallableRouter:
    route = "not-callable"


class NonCallableProviderRegistry:
    get_provider = "not-callable"


class ExecutionEngineTests(unittest.TestCase):
    def test_builds_with_valid_dependencies(self) -> None:
        router = FakeRouter()
        provider_registry = FakeProviderRegistry()

        engine = ExecutionEngine(
            router=router,
            provider_registry=provider_registry,
        )

        self.assertIs(engine.router, router)
        self.assertIs(
            engine.provider_registry,
            provider_registry,
        )
        self.assertEqual(router.route_calls, 0)
        self.assertEqual(
            provider_registry.get_provider_calls,
            0,
        )

    def test_rejects_missing_router(self) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            r"^router must implement route\(request\)$",
        ):
            ExecutionEngine(
                router=None,  # type: ignore[arg-type]
                provider_registry=FakeProviderRegistry(),
            )

    def test_returns_primary_success(self) -> None:
        routing_request = RoutingRequest(
            component_id="ranchbrain",
            request_id="request-1",
        )
        primary = FakeProvider(
            [response("ollama-primary")]
        )
        router = FakeRouter(decision(routing_request))
        registry = FakeProviderRegistry(
            {"ollama-primary": primary}
        )
        engine = ExecutionEngine(router, registry)

        result = engine.execute(
            routing_request,
            prompt="Summarize ranch tasks.",
            system_prompt="Be concise.",
            timeout_seconds=12,
            parameters={"temperature": 0.2},
            metadata={"source": "test"},
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(
            result.selected_model_id,
            "ollama-primary",
        )
        self.assertEqual(result.content, "Answer")
        self.assertEqual(
            result.attempted_model_ids,
            ("ollama-primary",),
        )
        self.assertEqual(router.route_calls, 1)
        self.assertEqual(
            registry.get_provider_calls,
            1,
        )
        self.assertEqual(
            primary.requests[0].request_id,
            "request-1",
        )
        self.assertEqual(
            primary.requests[0].system_prompt,
            "Be concise.",
        )
        self.assertEqual(
            primary.requests[0].parameters,
            {"temperature": 0.2},
        )

    def test_falls_back_after_timeout(self) -> None:
        routing_request = RoutingRequest(
            component_id="ranchbrain"
        )
        primary = FakeProvider(
            [ProviderTimeoutError("timed out")]
        )
        fallback = FakeProvider(
            [response("ollama-fallback-1")]
        )
        engine = ExecutionEngine(
            FakeRouter(decision(routing_request)),
            FakeProviderRegistry(
                {
                    "ollama-primary": primary,
                    "ollama-fallback-1": fallback,
                }
            ),
        )

        result = engine.execute(
            routing_request,
            prompt="Hello",
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(
            result.attempted_model_ids,
            (
                "ollama-primary",
                "ollama-fallback-1",
            ),
        )
        self.assertEqual(
            result.attempts[0].status,
            AttemptStatus.TIMEOUT,
        )
        self.assertEqual(
            result.attempts[1].status,
            AttemptStatus.SUCCESS,
        )
        self.assertTrue(result.request_id)
        self.assertEqual(
            primary.requests[0].request_id,
            fallback.requests[0].request_id,
        )

    def test_returns_failure_after_all_candidates(
        self,
    ) -> None:
        routing_request = RoutingRequest(
            component_id="ranchbrain",
            request_id="request-2",
        )
        providers = {
            "ollama-primary": FakeProvider(
                [ProviderUnavailableError("offline")]
            ),
            "ollama-fallback-1": FakeProvider(
                [
                    InvalidProviderResponseError(
                        "invalid response"
                    )
                ]
            ),
            "ollama-fallback-2": FakeProvider(
                [ProviderError("provider failed")]
            ),
        }
        engine = ExecutionEngine(
            FakeRouter(decision(routing_request)),
            FakeProviderRegistry(providers),
        )

        result = engine.execute(
            routing_request,
            prompt="Hello",
        )

        self.assertTrue(result.failed)
        self.assertEqual(
            tuple(
                attempt.status
                for attempt in result.attempts
            ),
            (
                AttemptStatus.UNAVAILABLE,
                AttemptStatus.INVALID_RESPONSE,
                AttemptStatus.PROVIDER_ERROR,
            ),
        )
        self.assertEqual(
            result.request_id,
            "request-2",
        )

    def test_missing_registered_provider_falls_back(
        self,
    ) -> None:
        routing_request = RoutingRequest(
            component_id="ranchbrain"
        )
        fallback = FakeProvider(
            [response("ollama-fallback-1")]
        )
        engine = ExecutionEngine(
            FakeRouter(decision(routing_request)),
            FakeProviderRegistry(
                {"ollama-fallback-1": fallback}
            ),
        )

        result = engine.execute(
            routing_request,
            prompt="Hello",
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(
            result.attempts[0].status,
            AttemptStatus.UNAVAILABLE,
        )

    def test_mismatched_response_uses_next_candidate(
        self,
    ) -> None:
        routing_request = RoutingRequest(
            component_id="ranchbrain"
        )
        primary = FakeProvider(
            [response("wrong-model")]
        )
        fallback = FakeProvider(
            [response("ollama-fallback-1")]
        )
        engine = ExecutionEngine(
            FakeRouter(decision(routing_request)),
            FakeProviderRegistry(
                {
                    "ollama-primary": primary,
                    "ollama-fallback-1": fallback,
                }
            ),
        )

        result = engine.execute(
            routing_request,
            prompt="Hello",
        )

        self.assertTrue(result.succeeded)
        self.assertEqual(
            result.attempts[0].status,
            AttemptStatus.INVALID_RESPONSE,
        )

    def test_unexpected_provider_error_propagates(
        self,
    ) -> None:
        routing_request = RoutingRequest(
            component_id="ranchbrain"
        )
        primary = FakeProvider(
            [RuntimeError("programming error")]
        )
        engine = ExecutionEngine(
            FakeRouter(decision(routing_request)),
            FakeProviderRegistry(
                {"ollama-primary": primary}
            ),
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "^programming error$",
        ):
            engine.execute(
                routing_request,
                prompt="Hello",
            )

    def test_rejects_router_without_route_method(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            r"^router must implement route\(request\)$",
        ):
            ExecutionEngine(
                router=object(),  # type: ignore[arg-type]
                provider_registry=FakeProviderRegistry(),
            )

    def test_rejects_non_callable_router(self) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            r"^router must implement route\(request\)$",
        ):
            ExecutionEngine(
                router=NonCallableRouter(),  # type: ignore[arg-type]
                provider_registry=FakeProviderRegistry(),
            )

    def test_rejects_missing_provider_registry(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            "^provider_registry must implement "
            r"get_provider\(model_id\)$",
        ):
            ExecutionEngine(
                router=FakeRouter(),
                provider_registry=None,  # type: ignore[arg-type]
            )

    def test_rejects_registry_without_lookup_method(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            "^provider_registry must implement "
            r"get_provider\(model_id\)$",
        ):
            ExecutionEngine(
                router=FakeRouter(),
                provider_registry=object(),  # type: ignore[arg-type]
            )

    def test_rejects_non_callable_registry(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ExecutionEngineConfigurationError,
            "^provider_registry must implement "
            r"get_provider\(model_id\)$",
        ):
            ExecutionEngine(
                router=FakeRouter(),
                provider_registry=(  # type: ignore[arg-type]
                    NonCallableProviderRegistry()
                ),
            )


if __name__ == "__main__":
    unittest.main()
