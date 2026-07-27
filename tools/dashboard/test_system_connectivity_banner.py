from __future__ import annotations

import unittest

from tools.dashboard.test_scorecard_approval import dashboard


class SystemConnectivityBannerTests(unittest.TestCase):
    def test_healthy_banner_requires_live_ollama_connection(self):
        html = dashboard.system_connectivity_panel_html(
            None,
            {
                "connected": True,
                "endpoint": "http://model-host:11434/api/tags",
            },
        )
        self.assertIn("All monitored OpenClaw services are connected.", html)

    def test_offline_ollama_replaces_green_banner(self):
        html = dashboard.system_connectivity_panel_html(
            None,
            {
                "connected": False,
                "endpoint": "http://model-host:11434/api/tags",
                "error": "Read timed out.",
            },
        )
        self.assertIn("AI model server connectivity warning", html)
        self.assertIn("Status: Offline", html)
        self.assertIn("Read timed out.", html)
        self.assertNotIn("All monitored OpenClaw services are connected.", html)

    def test_existing_drift_warning_takes_precedence(self):
        html = dashboard.system_connectivity_panel_html(
            {
                "file": "summary.txt",
                "warnings": ["Gateway connection refused"],
            },
            {
                "connected": False,
                "endpoint": "http://model-host:11434/api/tags",
                "error": "Read timed out.",
            },
        )
        self.assertIn("Gateway", html)
        self.assertNotIn("All monitored OpenClaw services are connected.", html)


if __name__ == "__main__":
    unittest.main()
