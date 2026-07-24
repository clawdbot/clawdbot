"""HTTP provider implementation for Ollama."""

from __future__ import annotations

import json
import socket
from time import perf_counter
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from tools.ai_intelligence.execution_models import (
    ProviderRequest,
    ProviderResponse,
)
from tools.ai_intelligence.ollama_config import (
    OllamaConfig,
    OllamaConfigurationError,
    is_ollama_model_id,
    to_ollama_model_name,
)
from tools.ai_intelligence.provider import (
    AIProvider,
    InvalidProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class OllamaProvider:
    """Execute model requests through Ollama's HTTP API."""

    def __init__(
        self,
        config: OllamaConfig | None = None,
    ) -> None:
        self._config = config or OllamaConfig.from_env()

    @property
    def name(self) -> str:
        return "ollama"

    def supports_model(self, model_id: str) -> bool:
        if not is_ollama_model_id(model_id):
            return False

        try:
            to_ollama_model_name(model_id)
        except OllamaConfigurationError:
            return False

        return True

    def execute(
        self,
        request: ProviderRequest,
    ) -> ProviderResponse:
        if not self.supports_model(request.model_id):
            raise ProviderUnavailableError(
                f"Ollama does not support model ID: "
                f"{request.model_id}"
            )

        model_name = to_ollama_model_name(
            request.model_id
        )

        timeout = (
            request.timeout_seconds
            or self._config.default_timeout_seconds
        )

        payload = {
            "model": model_name,
            "prompt": request.prompt,
            "stream": False,
            "options": dict(request.parameters),
        }

        encoded_payload = json.dumps(payload).encode(
            "utf-8"
        )

        http_request = Request(
            url=f"{self._config.base_url}/api/generate",
            data=encoded_payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

        started = perf_counter()

        try:
            with urlopen(
                http_request,
                timeout=timeout,
            ) as response:
                raw_body = response.read()
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderTimeoutError(
                f"Ollama request timed out after "
                f"{timeout} seconds"
            ) from exc
        except HTTPError as exc:
            raise ProviderUnavailableError(
                f"Ollama returned HTTP {exc.code}"
            ) from exc
        except URLError as exc:
            if isinstance(exc.reason, socket.timeout):
                raise ProviderTimeoutError(
                    f"Ollama request timed out after "
                    f"{timeout} seconds"
                ) from exc

            raise ProviderUnavailableError(
                f"Ollama is unavailable: {exc.reason}"
            ) from exc
        except OSError as exc:
            raise ProviderUnavailableError(
                f"Ollama connection failed: {exc}"
            ) from exc

        duration_ms = max(
            0,
            round((perf_counter() - started) * 1000),
        )

        parsed = self._parse_response(raw_body)

        return ProviderResponse(
            provider_name=self.name,
            model_id=request.model_id,
            content=parsed["response"],
            duration_ms=duration_ms,
            raw_response=parsed,
        )

    @staticmethod
    def _parse_response(
        raw_body: bytes,
    ) -> dict[str, Any]:
        try:
            decoded = raw_body.decode("utf-8")
            parsed = json.loads(decoded)
        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as exc:
            raise InvalidProviderResponseError(
                "Ollama returned invalid JSON"
            ) from exc

        if not isinstance(parsed, dict):
            raise InvalidProviderResponseError(
                "Ollama response must be a JSON object"
            )

        content = parsed.get("response")

        if not isinstance(content, str):
            raise InvalidProviderResponseError(
                "Ollama response is missing text content"
            )

        if not content.strip():
            raise InvalidProviderResponseError(
                "Ollama returned blank text content"
            )

        return parsed


def build_ollama_provider() -> AIProvider:
    """Build an Ollama provider from environment configuration."""

    return OllamaProvider()
