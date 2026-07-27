from __future__ import annotations

import subprocess
import unittest
from unittest import mock

from tools.dashboard.test_scorecard_approval import dashboard


class M4SshMetricsTests(unittest.TestCase):
    def test_missing_key_is_reported_as_credentials_not_configured(self):
        result = dashboard.classify_m4_ssh_metrics_error(
            FileNotFoundError("/missing/key"),
            "/missing/key",
        )
        self.assertEqual(result["status"], "Credentials not configured")
        self.assertIn("key is missing", result["summary"])

    def test_permission_denied_is_reported_as_rejected_credentials(self):
        error = subprocess.CalledProcessError(
            255,
            ["ssh"],
            output="user@host: Permission denied (publickey).",
        )
        with mock.patch.object(dashboard.Path, "is_file", return_value=True):
            result = dashboard.classify_m4_ssh_metrics_error(error, "/configured/key")
        self.assertEqual(result["status"], "Credentials rejected")
        self.assertEqual(result["technical"], "SSH authentication failed.")

    def test_network_and_service_failures_are_distinct(self):
        with mock.patch.object(dashboard.Path, "is_file", return_value=True):
            unreachable = dashboard.classify_m4_ssh_metrics_error(
                OSError("No route to host"),
                "/configured/key",
            )
            refused = dashboard.classify_m4_ssh_metrics_error(
                OSError("Connection refused"),
                "/configured/key",
            )
        self.assertEqual(unreachable["status"], "Host unreachable")
        self.assertEqual(refused["status"], "SSH service unavailable")

    def test_panel_does_not_call_ssh_when_key_is_missing(self):
        ollama = {
            "connected": True,
            "response_ms": 3,
            "model_count": 1,
            "detected_models": "test-model",
        }
        with (
            mock.patch.object(dashboard, "M4_SSH_KEY", "/missing/key"),
            mock.patch.object(dashboard.Path, "is_file", return_value=False),
            mock.patch.object(dashboard.subprocess, "check_output") as check_output,
        ):
            html = dashboard.m4_ai_health_panel_html(ollama)
        check_output.assert_not_called()
        self.assertIn("Credentials not configured", html)
        self.assertIn("metrics key is missing", html)
        self.assertNotIn("Host unreachable", html)


if __name__ == "__main__":
    unittest.main()
