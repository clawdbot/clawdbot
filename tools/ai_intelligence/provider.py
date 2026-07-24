"""Provider abstraction for the OpenClaw AI execution layer."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from tools.ai_intelligence.execution_models import (
    ProviderRequest,
    ProviderResponse,
)


class ProviderError(RuntimeError):
    """Base error raised by an AI provider."""


class ProviderTimeoutError(ProviderError):
    """Raised when a provider exceeds the allowed timeout."""


class ProviderUnavailableError(ProviderError):
    """Raised when a provider or model cannot be reached."""


class InvalidProviderResponseError(ProviderError):
    """Raised when a provider returns unusable output."""


@runtime_checkable
class AIProvider(Protocol):
    """Contract implemented by every model provider."""

    @property
    def name(self) -> str:
        """Stable provider identifier."""

        ...

    def supports_model(self, model_id: str) -> bool:
        """Return whether this provider handles the model."""

        ...

    def execute(
        self,
        request: ProviderRequest,
    ) -> ProviderResponse:
        """Execute one model request or raise ProviderError."""

        ...
