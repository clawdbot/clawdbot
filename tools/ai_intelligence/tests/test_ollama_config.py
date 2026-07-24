"""Tests for Ollama configuration and model translation."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from tools.ai_intelligence.ollama_config import (
    OllamaConfig,
    OllamaConfigurationError,
    is_ollama_model_id,
    to_ollama_model_name,
)


class OllamaModelTranslationTests(unittest.TestCase):
    def test_translates_known_model_ids(self) -> None:
        expected = {
            "ollama-hermes3-8b": "hermes3:8b",
            "ollama-gemma3-12b": "gemma3:12b",
            "ollama-llama3.2-3b": "llama3.2:3b",
        }

        for model_id, ollama_name in expected.items():
            with self.subTest(model_id=model_id):
                self.assertEqual(
                    to_ollama_model_name(model_id),
                    ollama_name,
                )

    def test_unknown_model_id_is_rejected(self) -> None:
        with self.assertRaises(OllamaConfigurationError):
            to_ollama_model_name("ollama-unknown-model")

    def test_blank_model_id_is_rejected(self) -> None:
        with self.assertRaises(OllamaConfigurationError):
            to_ollama_model_name(" ")

    def test_identifies_ollama_model_ids(self) -> None:
        self.assertTrue(
            is_ollama_model_id("ollama-hermes3-8b")
        )
        self.assertFalse(
            is_ollama_model_id("openai-gpt")
        )


class OllamaConfigTests(unittest.TestCase):
    def test_normalizes_base_url(self) -> None:
        config = OllamaConfig(
            base_url="http://192.168.50.117:11434/",
            default_timeout_seconds=30,
        )

        self.assertEqual(
            config.base_url,
            "http://192.168.50.117:11434",
        )

    def test_rejects_invalid_url_scheme(self) -> None:
        with self.assertRaises(OllamaConfigurationError):
            OllamaConfig(
                base_url="ftp://192.168.50.117:11434"
            )

    def test_rejects_invalid_timeout(self) -> None:
        with self.assertRaises(OllamaConfigurationError):
            OllamaConfig(
                base_url="http://192.168.50.117:11434",
                default_timeout_seconds=0,
            )

    def test_builds_from_environment(self) -> None:
        environment = {
            "OPENCLAW_OLLAMA_BASE_URL":
                "http://127.0.0.1:11434",
            "OPENCLAW_OLLAMA_TIMEOUT_SECONDS":
                "45",
        }

        with patch.dict(
            os.environ,
            environment,
            clear=False,
        ):
            config = OllamaConfig.from_env()

        self.assertEqual(
            config.base_url,
            "http://127.0.0.1:11434",
        )
        self.assertEqual(
            config.default_timeout_seconds,
            45.0,
        )

    def test_rejects_non_numeric_environment_timeout(
        self,
    ) -> None:
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_OLLAMA_TIMEOUT_SECONDS":
                    "not-a-number"
            },
            clear=False,
        ):
            with self.assertRaises(
                OllamaConfigurationError
            ):
                OllamaConfig.from_env()


if __name__ == "__main__":
    unittest.main()
