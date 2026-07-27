from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


API_DIR = Path(__file__).resolve().parent
ROOT = API_DIR.parents[2]
CONFIG_PATH = API_DIR / "gunicorn.conf.py"
RUNNER_PATH = API_DIR / "run_wsgi.sh"
UNIT_PATH = ROOT / "scripts/systemd/propertymanager-api.service"


def load_config():
    spec = importlib.util.spec_from_file_location(
        "propertymanager_gunicorn_config", CONFIG_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load PropertyManager Gunicorn configuration")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PropertyManagerWsgiRuntimeTests(unittest.TestCase):
    def test_wsgi_entry_point_exports_flask_application(self):
        sys.path.insert(0, str(API_DIR))
        try:
            import wsgi

            self.assertIs(wsgi.application, wsgi.app)
            client = wsgi.application.test_client()
            response = client.get("/health")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["service"], "propertymanager-api")
        finally:
            sys.path.remove(str(API_DIR))
            sys.modules.pop("wsgi", None)

    def test_gunicorn_policy_is_bounded_and_resilient(self):
        config = load_config()
        self.assertEqual(config.bind, "0.0.0.0:5062")
        self.assertGreaterEqual(config.workers, 2)
        self.assertEqual(config.worker_class, "gthread")
        self.assertGreaterEqual(config.threads, 2)
        self.assertGreater(config.timeout, 0)
        self.assertGreater(config.graceful_timeout, 0)
        self.assertGreater(config.max_requests, 0)
        self.assertGreater(config.max_requests_jitter, 0)

    def test_runner_uses_gunicorn_and_not_flask_development_server(self):
        runner = RUNNER_PATH.read_text(encoding="utf-8")
        self.assertIn(".venv/bin/gunicorn", runner)
        self.assertIn("wsgi:application", runner)
        self.assertIn('PROPERTYMANAGER_DB_NAME" != *_dev', runner)
        self.assertNotIn("propertymanager_api.py", runner)
        self.assertNotIn("flask run", runner)

    def test_systemd_unit_uses_runner_and_restart_protection(self):
        unit = UNIT_PATH.read_text(encoding="utf-8")
        self.assertIn("run_wsgi.sh", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertIn("KillMode=control-group", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertIn("OPENCLAW_ENVIRONMENT=development", unit)
        self.assertIn("PROPERTYMANAGER_DB_NAME=openclaw_ai_dev", unit)
        self.assertIn("PROPERTYMANAGER_POSTGRES_CONTAINER=openclaw-ai-postgres-dev", unit)
        self.assertNotIn("propertymanager_api.py", unit)


if __name__ == "__main__":
    unittest.main()
