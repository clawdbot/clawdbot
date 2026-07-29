#!/usr/bin/env python3
"""Unit tests for PropertyManager Gunicorn / WSGI runtime configuration."""

from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

API_DIR = Path(__file__).resolve().parents[1] / "api"
ROOT = Path(__file__).resolve().parents[3]
CONFIG_PATH = API_DIR / "gunicorn.conf.py"
WSGI_PATH = API_DIR / "wsgi.py"
UNIT_PATH = Path(__file__).resolve().parents[1] / "deploy" / "propertymanager-api.service"


def load_config():
    spec = importlib.util.spec_from_file_location("pm_gunicorn_config", CONFIG_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PropertyManagerWsgiConfigurationTests(unittest.TestCase):
    def test_reliable_default_worker_configuration(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            # Clear overrides that may be set in the shell.
            for key in (
                "PROPERTYMANAGER_API_BIND",
                "PROPERTYMANAGER_API_PORT",
                "PROPERTYMANAGER_API_WORKERS",
                "PROPERTYMANAGER_API_TIMEOUT",
                "PROPERTYMANAGER_API_GRACEFUL_TIMEOUT",
            ):
                os.environ.pop(key, None)
            config = load_config()

        self.assertEqual(config.bind, "0.0.0.0:5062")
        self.assertEqual(config.workers, 2)
        self.assertEqual(config.worker_class, "sync")
        self.assertEqual(config.timeout, 120)
        self.assertGreater(config.graceful_timeout, 0)
        self.assertFalse(config.reload)
        self.assertFalse(config.preload_app)
        self.assertGreater(config.max_requests, 0)
        self.assertTrue(str(config.pidfile).endswith("propertymanager-api.pid"))

    def test_runtime_settings_can_be_overridden_without_code_changes(self):
        environment = {
            "PROPERTYMANAGER_API_BIND": "127.0.0.1:15062",
            "PROPERTYMANAGER_API_WORKERS": "3",
            "PROPERTYMANAGER_API_TIMEOUT": "90",
            "PROPERTYMANAGER_API_GRACEFUL_TIMEOUT": "15",
            "PROPERTYMANAGER_PID_DIR": "/tmp/pm-dev-test",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            config = load_config()

        self.assertEqual(config.bind, "127.0.0.1:15062")
        self.assertEqual(config.workers, 3)
        self.assertEqual(config.timeout, 90)
        self.assertEqual(config.graceful_timeout, 15)
        self.assertIn("pm-dev-test", config.pidfile)

    def test_wsgi_module_exports_application_without_starting_server(self):
        spec = importlib.util.spec_from_file_location("pm_wsgi", WSGI_PATH)
        assert spec is not None
        assert spec.loader is not None
        # Import via file location with api dir on sys.path (same as gunicorn chdir).
        import sys

        sys.path.insert(0, str(API_DIR))
        try:
            module = importlib.util.module_from_spec(spec)
            with mock.patch("propertymanager_api.app.run") as run_mock:
                # Loading wsgi imports propertymanager_api; ensure no app.run side effect.
                spec.loader.exec_module(module)
                self.assertTrue(hasattr(module, "application"))
                self.assertIs(module.application, module.application)
                run_mock.assert_not_called()
        finally:
            if str(API_DIR) in sys.path:
                sys.path.remove(str(API_DIR))

    def test_systemd_unit_uses_gunicorn_and_restart_protection(self):
        unit = UNIT_PATH.read_text(encoding="utf-8")
        self.assertIn("Type=simple", unit)
        self.assertIn("run_api.sh", unit)
        self.assertIn("Gunicorn", unit)
        self.assertIn("ExecReload=/bin/kill -s HUP $MAINPID", unit)
        self.assertIn("KillSignal=SIGQUIT", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertIn("openclaw-cursor-propertymanager", unit)
        self.assertNotIn("propertymanager_api.py", unit)
        self.assertIn("development vm", unit.lower())

    def test_run_api_starts_gunicorn_not_flask(self):
        script = (API_DIR / "run_api.sh").read_text(encoding="utf-8")
        self.assertIn("gunicorn", script)
        self.assertIn("wsgi:application", script)
        self.assertIn("gunicorn.conf.py", script)
        self.assertNotIn("propertymanager_api.py", script)


if __name__ == "__main__":
    unittest.main()
