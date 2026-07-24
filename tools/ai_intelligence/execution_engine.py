"""Provider-neutral AI execution with ordered model fallback."""

from __future__ import annotations

from collections.abc import Mapping
from time import perf_counter
from typing import Any, Protocol, runtime_checkable
from uuid import uuid4

from tools.ai_intelligence.execution_models import (
    AttemptStatus,
    ExecutionAttempt,
    ExecutionResult,
    ExecutionStatus,
    ProviderRequest,
    ProviderResponse,
    utc_now,
)
from tools.ai_intelligence.provider import (
    AIProvider,
    InvalidProviderResponseError,
    ProviderError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
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
    """Route requests and return the first successful provider response."""

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

    def execute(
        self,
        routing_request: RoutingRequest,
        *,
        prompt: str,
        system_prompt: str | None = None,
        timeout_seconds: float = 60.0,
        parameters: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> ExecutionResult:
        """Execute candidates in routing order until one succeeds."""

        decision = self._router.route(routing_request)
        request_id = (
            routing_request.request_id
            or str(uuid4())
        )
        attempts: list[ExecutionAttempt] = []

        for assignment in decision.chain.ordered_candidates:
            started_at = utc_now()
            started = perf_counter()

            try:
                provider = self._provider_registry.get_provider(
                    assignment.model_id
                )
                response = provider.execute(
                    ProviderRequest(
                        model_id=assignment.model_id,
                        prompt=prompt,
                        request_id=request_id,
                        system_prompt=system_prompt,
                        timeout_seconds=timeout_seconds,
                        parameters=parameters or {},
                        metadata=metadata or {},
                    )
                )
                self._validate_response(
                    response=response,
                    provider=provider,
                    model_id=assignment.model_id,
                )
            except ProviderError as exc:
                finished_at = utc_now()
                attempts.append(
                    ExecutionAttempt.failure(
                        provider_name=assignment.provider,
                        model_id=assignment.model_id,
                        status=self._status_for_error(exc),
                        started_at=started_at,
                        finished_at=finished_at,
                        duration_ms=self._duration_ms(started),
                        error=exc,
                    )
                )
                continue

            finished_at = utc_now()
            attempt = ExecutionAttempt.success(
                response,
                started_at=started_at,
                finished_at=finished_at,
            )
            attempts.append(attempt)

            return ExecutionResult(
                request_id=request_id,
                component_id=routing_request.component_id,
                status=ExecutionStatus.SUCCESS,
                attempts=tuple(attempts),
                content=response.content,
                selected_model_id=response.model_id,
            )

        return ExecutionResult(
            request_id=request_id,
            component_id=routing_request.component_id,
            status=ExecutionStatus.FAILED,
            attempts=tuple(attempts),
        )

    @staticmethod
    def _validate_response(
        *,
        response: ProviderResponse,
        provider: AIProvider,
        model_id: str,
    ) -> None:
        if response.provider_name != provider.name:
            raise InvalidProviderResponseError(
                "Provider response name does not match "
                f"executing provider: expected={provider.name}, "
                f"received={response.provider_name}"
            )

        if response.model_id != model_id:
            raise InvalidProviderResponseError(
                "Provider response model does not match "
                f"requested model: expected={model_id}, "
                f"received={response.model_id}"
            )

    @staticmethod
    def _status_for_error(
        error: ProviderError,
    ) -> AttemptStatus:
        if isinstance(error, ProviderTimeoutError):
            return AttemptStatus.TIMEOUT

        if isinstance(error, ProviderUnavailableError):
            return AttemptStatus.UNAVAILABLE

        if isinstance(
            error,
            InvalidProviderResponseError,
        ):
            return AttemptStatus.INVALID_RESPONSE

        return AttemptStatus.PROVIDER_ERROR

    @staticmethod
    def _duration_ms(started: float) -> int:
        return max(
            0,
            round((perf_counter() - started) * 1000),
        )
