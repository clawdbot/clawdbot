"""Focused tests for the dashboard scorecard approval page."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


class DummyFlask:
    def __init__(self, *_args, **_kwargs):
        self.config = {}

    def route(self, *_args, **_kwargs):
        return lambda function: function

    get = route
    post = route
    errorhandler = route


class DummyRequest:
    remote_addr = "127.0.0.1"
    form = {}
    args = {}
    files = {}
    method = "GET"


def install_stubs():
    flask = types.ModuleType("flask")
    flask.Flask = DummyFlask
    flask.request = DummyRequest()
    flask.redirect = lambda location: location
    flask.abort = lambda code: (_ for _ in ()).throw(PermissionError(code))
    flask.send_from_directory = lambda *_args, **_kwargs: None
    sys.modules["flask"] = flask

    requests = types.ModuleType("requests")
    requests.get = mock.Mock()
    requests.post = mock.Mock()
    sys.modules["requests"] = requests

    markdown = types.ModuleType("markdown")
    markdown.markdown = lambda value, **_kwargs: value
    sys.modules["markdown"] = markdown

    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.connect = mock.Mock()
    sys.modules["psycopg2"] = psycopg2

    pypdf = types.ModuleType("pypdf")
    pypdf.PdfReader = object
    sys.modules["pypdf"] = pypdf

    werkzeug = types.ModuleType("werkzeug")
    werkzeug_utils = types.ModuleType("werkzeug.utils")
    werkzeug_utils.secure_filename = lambda value: value
    sys.modules["werkzeug"] = werkzeug
    sys.modules["werkzeug.utils"] = werkzeug_utils

    matplotlib = types.ModuleType("matplotlib")
    matplotlib.use = lambda *_args, **_kwargs: None
    pyplot = types.ModuleType("matplotlib.pyplot")
    dates = types.ModuleType("matplotlib.dates")
    sys.modules["matplotlib"] = matplotlib
    sys.modules["matplotlib.pyplot"] = pyplot
    sys.modules["matplotlib.dates"] = dates


install_stubs()
MODULE_PATH = Path(__file__).with_name("app.py")
SPEC = importlib.util.spec_from_file_location("dashboard_app", MODULE_PATH)
assert SPEC is not None
assert SPEC.loader is not None
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)


class ScorecardDashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        reports = root / "reports"
        config = root / "config"
        reports.mkdir()
        config.mkdir()

        dashboard.AI_EVALUATION_PATH = reports / "evaluation.json"
        dashboard.AI_APPROVAL_PATH = reports / "approval.json"
        dashboard.AI_CANDIDATES_PATH = reports / "candidates.json"
        dashboard.AI_PROMOTION_DIR = reports / "promotions"
        dashboard.AI_SCORECARD_PATH = config / "scorecard.json"

        dashboard.AI_EVALUATION_PATH.write_text(
            json.dumps(
                {
                    "pipeline_id": "pipeline-1",
                    "benchmark_reconciliation": {
                        "safe-tool-use": {
                            "promotion_eligible": True,
                            "winner_passed_deterministic_validation": True,
                            "final_winner": "gemma3:12b",
                            "final_status": "passed",
                        }
                    },
                }
            )
        )
        dashboard.AI_APPROVAL_PATH.write_text(
            json.dumps(
                {
                    "decision": "approved",
                    "decision_id": "decision-1",
                }
            )
        )
        dashboard.AI_CANDIDATES_PATH.write_text(json.dumps({"candidates": []}))
        dashboard.AI_SCORECARD_PATH.write_text(json.dumps({"models": {}}))

    def tearDown(self):
        self.temp.cleanup()

    def test_snapshot_reports_eligible_winner_and_applied_audit(self):
        dashboard.AI_PROMOTION_DIR.mkdir()
        (dashboard.AI_PROMOTION_DIR / "scorecard-promotion-decision-1.json").write_text(
            json.dumps({"decision_id": "decision-1", "status": "applied"})
        )

        snapshot = dashboard.scorecard_snapshot()

        self.assertEqual(snapshot["eligible"][0]["model"], "gemma3:12b")
        self.assertTrue(snapshot["promotion_applied"])

    def test_mutations_require_loopback(self):
        dashboard.request.remote_addr = "192.168.50.20"

        with self.assertRaises(PermissionError):
            dashboard.require_local_scorecard_action()

    def test_action_uses_argument_list_without_shell(self):
        completed = types.SimpleNamespace(
            returncode=0,
            stdout="approved",
            stderr="",
        )
        with mock.patch.object(
            dashboard.subprocess,
            "run",
            return_value=completed,
        ) as run:
            success, output = dashboard.run_scorecard_action(
                Path("/tool.py"),
                "--approve",
                "pipeline-1",
            )

        self.assertTrue(success)
        self.assertEqual(output, "approved")
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[-2:], ["--approve", "pipeline-1"])
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_promotion_requires_exact_decision_confirmation(self):
        dashboard.request.remote_addr = "127.0.0.1"
        dashboard.request.form = {"confirmation": "PROMOTE wrong"}

        with mock.patch.object(dashboard, "run_scorecard_action") as action:
            response = dashboard.ai_scorecard_promote()

        self.assertIn("Promotion%20confirmation%20did%20not%20match", response)
        action.assert_not_called()


if __name__ == "__main__":
    unittest.main()
