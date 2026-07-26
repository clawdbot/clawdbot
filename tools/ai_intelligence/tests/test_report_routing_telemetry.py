"""Tests for development AI routing telemetry report configuration."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "report_routing_telemetry.py"
SPEC = importlib.util.spec_from_file_location(
    "report_routing_telemetry",
    MODULE_PATH,
)
assert SPEC is not None
assert SPEC.loader is not None
reporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reporter)


class RoutingTelemetryReportTests(unittest.TestCase):
    def test_prefers_existing_development_credentials_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            development = root / "ai-intelligence-dev.env"
            generic = root / "ai-intelligence.env"
            development.write_text(
                "\n".join(
                    [
                        "OPENCLAW_DB_HOST=development-db",
                        "OPENCLAW_DB_PORT=5432",
                        "OPENCLAW_DB_NAME=openclaw_ai_dev",
                        "OPENCLAW_DB_USER=openclaw",
                        "OPENCLAW_DB_PASSWORD=test-only",
                    ]
                ),
                encoding="utf-8",
            )
            generic.write_text(
                development.read_text(encoding="utf-8").replace(
                    "development-db",
                    "generic-db",
                ),
                encoding="utf-8",
            )

            with (
                mock.patch.object(
                    reporter,
                    "CREDENTIALS_PATHS",
                    (development, generic),
                ),
                mock.patch.dict(os.environ, {}, clear=True),
            ):
                reporter.load_database_environment()
                self.assertEqual(
                    os.environ["OPENCLAW_DB_HOST"],
                    "development-db",
                )

    def test_missing_credentials_error_lists_checked_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.env"
            second = Path(directory) / "second.env"

            with (
                mock.patch.object(
                    reporter,
                    "CREDENTIALS_PATHS",
                    (first, second),
                ),
                mock.patch.dict(os.environ, {}, clear=True),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "credentials file not found",
                ):
                    reporter.load_database_environment()


if __name__ == "__main__":
    unittest.main()
