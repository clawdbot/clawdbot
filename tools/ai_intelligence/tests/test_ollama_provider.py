"""Tests for the Ollama HTTP provider."""

from __future__ import annotations

import io
import json
import socket
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from tools.ai_intelligence.execution_models import (
    ProviderRequest,
)
from tools.ai_intelligence.ollama_config import (
    OllamaConfig,
)
from tools.ai_intelligence.ollama_provider import (
    OllamaProvider,
    build_ollama_provider,
)
from tools.ai_intelligence.provider import (
    AIProvider,
    InvalidProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class FakeHTTPResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def __enter__(self) -> "FakeHTTPResponse":
        return self

    def __exit__(
        self,
        exc_type: object,
        exc: object,
        traceback: object,
    ) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


class OllamaProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.provider = OllamaProvider(
            OllamaConfig(
                base_url="http://127.0.0.1:11434",
                default_timeout_seconds=30,
            )
        )

        self.request = ProviderRequest(
            model_id="ollama-hermes3-8b",
            prompt="Hello",
            timeout_seconds=15,
            parameters={
                "temperature": 0.2,
            },
        )

    def test_implements_provider_contract(self) -> None:
        self.assertIsInstance(
            self.provider,
            AIProvider,
        )
        self.assertEqual(
            self.provider.name,
            "ollama",
        )

    def test_supports_known_ollama_model(self) -> None:
        self.assertTrue(
            self.provider.supports_model(
                "ollama-hermes3-8b"
            )
        )

    def test_rejects_unknown_ollama_model(self) -> None:
        self.assertFalse(
            self.provider.supports_model(
                "ollama-unknown-model"
            )
        )

    def test_rejects_non_ollama_model(self) -> None:
        self.assertFalse(
            self.provider.supports_model(
                "openai-gpt"
            )
        )

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_executes_generate_request(
        self,
        mock_urlopen,
    ) -> None:
        response_payload = json.dumps(
            {
                "model": "hermes3:8b",
                "response": "Hello from Ollama",
                "done": True,
                "eval_count": 8,
            }
        ).encode("utf-8")

        mock_urlopen.return_value = FakeHTTPResponse(
            response_payload
        )

        response = self.provider.execute(
            self.request
        )

        self.assertEqual(
            response.provider_name,
            "ollama",
        )
        self.assertEqual(
            response.model_id,
            "ollama-hermes3-8b",
        )
        self.assertEqual(
            response.content,
            "Hello from Ollama",
        )
        self.assertEqual(
            response.raw_response["model"],
            "hermes3:8b",
        )
        self.assertEqual(
            response.raw_response["eval_count"],
            8,
        )

        call_args = mock_urlopen.call_args
        http_request = call_args.args[0]
        timeout = call_args.kwargs["timeout"]

        sent_payload = json.loads(
            http_request.data.decode("utf-8")
        )

        self.assertEqual(
            sent_payload["model"],
            "hermes3:8b",
        )
        self.assertEqual(
            sent_payload["prompt"],
            "Hello",
        )
        self.assertFalse(
            sent_payload["stream"]
        )
        self.assertEqual(
            sent_payload["options"]["temperature"],
            0.2,
        )
        self.assertEqual(
            timeout,
            15,
        )

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_timeout_is_normalized(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.side_effect = socket.timeout()

        with self.assertRaises(
            ProviderTimeoutError
        ):
            self.provider.execute(self.request)

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_url_timeout_is_normalized(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.side_effect = URLError(
            socket.timeout()
        )

        with self.assertRaises(
            ProviderTimeoutError
        ):
            self.provider.execute(self.request)

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_unavailable_server_is_normalized(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.side_effect = URLError(
            "connection refused"
        )

        with self.assertRaises(
            ProviderUnavailableError
        ):
            self.provider.execute(self.request)

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_http_error_is_normalized(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.side_effect = HTTPError(
            url="http://127.0.0.1:11434/api/generate",
            code=500,
            msg="Server error",
            hdrs=None,
            fp=io.BytesIO(),
        )

        with self.assertRaises(
            ProviderUnavailableError
        ):
            self.provider.execute(self.request)

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_invalid_json_is_rejected(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.return_value = FakeHTTPResponse(
            b"not-json"
        )

        with self.assertRaises(
            InvalidProviderResponseError
        ):
            self.provider.execute(self.request)

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_missing_response_text_is_rejected(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.return_value = FakeHTTPResponse(
            json.dumps(
                {
                    "model": "hermes3:8b",
                    "done": True,
                }
            ).encode("utf-8")
        )

        with self.assertRaises(
            InvalidProviderResponseError
        ):
            self.provider.execute(self.request)

    @patch(
        "tools.ai_intelligence.ollama_provider.urlopen"
    )
    def test_blank_response_text_is_rejected(
        self,
        mock_urlopen,
    ) -> None:
        mock_urlopen.return_value = FakeHTTPResponse(
            json.dumps(
                {
                    "response": " ",
                    "done": True,
                }
            ).encode("utf-8")
        )

        with self.assertRaises(
            InvalidProviderResponseError
        ):
            self.provider.execute(self.request)

    def test_unsupported_model_fails_before_network(
        self,
    ) -> None:
        request = ProviderRequest(
            model_id="openai-gpt",
            prompt="Hello",
        )

        with self.assertRaises(
            ProviderUnavailableError
        ):
            self.provider.execute(request)

    def test_builder_returns_provider(self) -> None:
        provider = build_ollama_provider()

        self.assertIsInstance(
            provider,
            AIProvider,
        )


if __name__ == "__main__":
    unittest.main()
