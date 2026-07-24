"""Registry for selecting an AI provider by model ID."""

from __future__ import annotations

from collections.abc import Iterable

from tools.ai_intelligence.provider import (
    AIProvider,
    ProviderUnavailableError,
)


class ProviderRegistryError(ValueError):
    """Raised when the provider registry is configured incorrectly."""


class ProviderRegistry:
    """Resolve model IDs to registered provider implementations."""

    def __init__(
        self,
        providers: Iterable[AIProvider],
    ) -> None:
        provider_list = tuple(providers)

        if not provider_list:
            raise ProviderRegistryError(
                "At least one provider must be registered"
            )

        names = [provider.name for provider in provider_list]

        if any(not name.strip() for name in names):
            raise ProviderRegistryError(
                "Provider names must not be blank"
            )

        if len(names) != len(set(names)):
            raise ProviderRegistryError(
                "Provider names must be unique"
            )

        self._providers = provider_list

    @property
    def providers(self) -> tuple[AIProvider, ...]:
        """Return providers in registration order."""

        return self._providers

    def get_provider(
        self,
        model_id: str,
    ) -> AIProvider:
        """Return the provider that supports the model ID."""

        normalized_id = model_id.strip()

        if not normalized_id:
            raise ProviderUnavailableError(
                "model_id must not be blank"
            )

        matches = tuple(
            provider
            for provider in self._providers
            if provider.supports_model(normalized_id)
        )

        if not matches:
            raise ProviderUnavailableError(
                f"No registered provider supports model ID: "
                f"{normalized_id}"
            )

        if len(matches) > 1:
            names = ", ".join(
                provider.name for provider in matches
            )

            raise ProviderRegistryError(
                f"Multiple providers support model ID "
                f"{normalized_id}: {names}"
            )

        return matches[0]

    def supports_model(self, model_id: str) -> bool:
        """Return whether exactly one provider supports the model."""

        try:
            self.get_provider(model_id)
        except ProviderUnavailableError:
            return False

        return True
