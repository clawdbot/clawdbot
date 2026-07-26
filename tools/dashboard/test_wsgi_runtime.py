from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).with_name("gunicorn.conf.py")


def load_config():
    spec = importlib.util.spec_from_file_location("dashboard_gunicorn_config", CONFIG_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DashboardWsgiConfigurationTests(unittest.TestCase):
    def test_reliable_default_worker_configuration(self):
        config = load_config()

        self.assertEqual(config.bind, "0.0.0.0:5051")
        self.assertEqual(config.workers, 2)
        self.assertEqual(config.threads, 4)
        self.assertEqual(config.worker_class, "gthread")
        self.assertGreaterEqual(config.timeout, 180)
        self.assertGreater(config.graceful_timeout, 0)
        self.assertGreater(config.max_requests, 0)
        self.assertGreater(config.max_requests_jitter, 0)
        self.assertFalse(config.preload_app)

    def test_runtime_settings_can_be_overridden_without_code_changes(self):
        environment = {
            "OPENCLAW_DASHBOARD_BIND": "127.0.0.1:15052",
            "OPENCLAW_DASHBOARD_WORKERS": "1",
            "OPENCLAW_DASHBOARD_THREADS": "2",
            "OPENCLAW_DASHBOARD_TIMEOUT": "240",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            config = load_config()

        self.assertEqual(config.bind, "127.0.0.1:15052")
        self.assertEqual(config.workers, 1)
        self.assertEqual(config.threads, 2)
        self.assertEqual(config.timeout, 240)

    def test_systemd_unit_uses_gunicorn_and_restart_protection(self):
        unit = (
            ROOT / "scripts/systemd/openclaw-dashboard.service"
        ).read_text(encoding="utf-8")

        self.assertIn("Type=simple", unit)
        self.assertIn(".venv-dashboard/bin/gunicorn", unit)
        self.assertIn("tools.dashboard.wsgi:application", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertIn("KillSignal=SIGQUIT", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertNotIn("tools/dashboard/app.py", unit)


if __name__ == "__main__":
    unittest.main()
