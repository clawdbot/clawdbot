"""Tests for the AI provider registry."""

from __future__ import annotations

import unittest

from tools.ai_intelligence.execution_models import (
    ProviderRequest,
    ProviderResponse,
)
from tools.ai_intelligence.provider import (
    AIProvider,
    ProviderUnavailableError,
)
from tools.ai_intelligence.provider_registry import (
    ProviderRegistry,
    ProviderRegistryError,
)


class FakeProvider:
    def __init__(
        self,
        name: str,
        prefix: str,
    ) -> None:
        self._name = name
        self._prefix = prefix

    @property
    def name(self) -> str:
        return self._name

    def supports_model(self, model_id: str) -> bool:
        return model_id.startswith(self._prefix)

    def execute(
        self,
        request: ProviderRequest,
    ) -> ProviderResponse:
        return ProviderResponse(
            provider_name=self.name,
            model_id=request.model_id,
            content=f"Response from {self.name}",
            duration_ms=1,
        )


class ProviderRegistryTests(unittest.TestCase):
    def test_requires_at_least_one_provider(self) -> None:
        with self.assertRaises(
            ProviderRegistryError
        ):
            ProviderRegistry(())

    def test_rejects_duplicate_provider_names(
        self,
    ) -> None:
        with self.assertRaises(
            ProviderRegistryError
        ):
            ProviderRegistry(
                (
                    FakeProvider("local", "local-"),
                    FakeProvider("local", "other-"),
                )
            )

    def test_rejects_blank_provider_name(self) -> None:
        with self.assertRaises(
            ProviderRegistryError
        ):
            ProviderRegistry(
                (
                    FakeProvider(" ", "local-"),
                )
            )

    def test_returns_registered_providers(self) -> None:
        provider = FakeProvider(
            "local",
            "local-",
        )

        registry = ProviderRegistry((provider,))

        self.assertEqual(
            registry.providers,
            (provider,),
        )

    def test_resolves_supported_model(self) -> None:
        local = FakeProvider(
            "local",
            "local-",
        )

        cloud = FakeProvider(
            "cloud",
            "cloud-",
        )

        registry = ProviderRegistry(
            (
                local,
                cloud,
            )
        )

        selected = registry.get_provider(
            "cloud-model"
        )

        self.assertIs(
            selected,
            cloud,
        )
        self.assertIsInstance(
            selected,
            AIProvider,
        )

    def test_unknown_model_is_rejected(self) -> None:
        registry = ProviderRegistry(
            (
                FakeProvider(
                    "local",
                    "local-",
                ),
            )
        )

        with self.assertRaises(
            ProviderUnavailableError
        ):
            registry.get_provider(
                "unknown-model"
            )

    def test_blank_model_is_rejected(self) -> None:
        registry = ProviderRegistry(
            (
                FakeProvider(
                    "local",
                    "local-",
                ),
            )
        )

        with self.assertRaises(
            ProviderUnavailableError
        ):
            registry.get_provider(" ")

    def test_ambiguous_model_is_rejected(self) -> None:
        registry = ProviderRegistry(
            (
                FakeProvider(
                    "first",
                    "shared-",
                ),
                FakeProvider(
                    "second",
                    "shared-",
                ),
            )
        )

        with self.assertRaises(
            ProviderRegistryError
        ):
            registry.get_provider(
                "shared-model"
            )

    def test_supports_model(self) -> None:
        registry = ProviderRegistry(
            (
                FakeProvider(
                    "local",
                    "local-",
                ),
            )
        )

        self.assertTrue(
            registry.supports_model(
                "local-model"
            )
        )

        self.assertFalse(
            registry.supports_model(
                "cloud-model"
            )
        )


if __name__ == "__main__":
    unittest.main()
