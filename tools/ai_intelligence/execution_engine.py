"""Provider-neutral AI execution engine foundation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

from tools.ai_intelligence.provider import AIProvider

if TYPE_CHECKING:
    from tools.ai_intelligence.routing_models import (
        RoutingDecision,
        RoutingRequest,
    )


class ExecutionEngineConfigurationError(ValueError):
    """Raised when execution engine dependencies are invalid."""


@runtime_checkable
class ExecutionRouter(Protocol):
    """Routing behavior required by the execution engine."""

    def route(
        self,
        request: RoutingRequest,
    ) -> RoutingDecision:
        ...


@runtime_checkable
class ExecutionProviderRegistry(Protocol):
    """Provider lookup behavior required by the execution engine."""

    def get_provider(
        self,
        model_id: str,
    ) -> AIProvider:
        ...


class ExecutionEngine:
    """Coordinate routing and provider execution.

    Phase 2F.4G-A establishes dependency contracts only. Request execution
    and fallback behavior are added in later 2F.4G subphases.
    """

    def __init__(
        self,
        router: ExecutionRouter,
        provider_registry: ExecutionProviderRegistry,
    ) -> None:
        if (
            not isinstance(router, ExecutionRouter)
            or not callable(router.route)
        ):
            raise ExecutionEngineConfigurationError(
                "router must implement route(request)"
            )

        if not isinstance(
            provider_registry,
            ExecutionProviderRegistry,
        ) or not callable(provider_registry.get_provider):
            raise ExecutionEngineConfigurationError(
                "provider_registry must implement "
                "get_provider(model_id)"
            )

        self._router = router
        self._provider_registry = provider_registry

    @property
    def router(self) -> ExecutionRouter:
        """Return the configured runtime router."""

        return self._router

    @property
    def provider_registry(
        self,
    ) -> ExecutionProviderRegistry:
        """Return the configured provider registry."""

        return self._provider_registry
