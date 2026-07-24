"""Tests for the provider abstraction contract."""

from __future__ import annotations

import unittest

from tools.ai_intelligence.execution_models import (
    ProviderRequest,
    ProviderResponse,
)
from tools.ai_intelligence.provider import AIProvider


class FakeProvider:
    @property
    def name(self) -> str:
        return "fake"

    def supports_model(self, model_id: str) -> bool:
        return model_id.startswith("fake-")

    def execute(
        self,
        request: ProviderRequest,
    ) -> ProviderResponse:
        return ProviderResponse(
            provider_name=self.name,
            model_id=request.model_id,
            content="Fake response",
            duration_ms=1,
        )


class ProviderContractTests(unittest.TestCase):
    def test_runtime_provider_contract(self) -> None:
        provider = FakeProvider()

        self.assertIsInstance(provider, AIProvider)
        self.assertEqual(provider.name, "fake")
        self.assertTrue(
            provider.supports_model("fake-model")
        )

    def test_fake_provider_executes_request(self) -> None:
        provider = FakeProvider()

        response = provider.execute(
            ProviderRequest(
                model_id="fake-model",
                prompt="Hello",
            )
        )

        self.assertEqual(
            response.content,
            "Fake response",
        )


if __name__ == "__main__":
    unittest.main()
