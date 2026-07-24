"""Tests for the AI execution engine foundation."""

from __future__ import annotations

import unittest
from typing import Any

from tools.ai_intelligence.execution_engine import (
    ExecutionEngine,
    ExecutionEngineConfigurationError,
)
from tools.ai_intelligence.provider import AIProvider


class FakeRouter:
    def __init__(self) -> None:
        self.route_calls = 0

    def route(
        self,
        request: Any,
    ) -> Any:
        self.route_calls += 1
        raise AssertionError(
            "constructor must not route requests"
        )


class FakeProviderRegistry:
    def __init__(self) -> None:
        self.get_provider_calls = 0

    def get_provider(
        self,
        model_id: str,
    ) -> AIProvider:
        self.get_provider_calls += 1
        raise AssertionError(
            "constructor must not resolve providers"
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
