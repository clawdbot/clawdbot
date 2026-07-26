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
        dashboard.request.remote_addr = "127.0.0.1"
        dashboard.request.form = {}
        dashboard.request.args = {}
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        reports = root / "reports"
        config = root / "config"
        reports.mkdir()
        config.mkdir()

        dashboard.AI_EVALUATION_PATH = reports / "evaluation-lab-latest.json"
        dashboard.AI_APPROVAL_PATH = reports / "evaluation-approval-latest.json"
        dashboard.AI_CANDIDATES_PATH = reports / "candidates.json"
        dashboard.AI_PROMOTION_DIR = reports / "promotions"
        dashboard.AI_SCORECARD_PATH = config / "scorecard.json"
        dashboard.AI_BENCHMARK_PATH = reports / "benchmark.json"
        dashboard.AI_VALIDATION_PATH = reports / "validation.json"
        dashboard.AI_REVIEW_PATH = reports / "review.json"

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
                    "pipeline_id": "pipeline-1",
                }
            )
        )
        dashboard.AI_CANDIDATES_PATH.write_text(json.dumps({"candidates": []}))
        dashboard.AI_SCORECARD_PATH.write_text(json.dumps({"models": {}}))
        dashboard.AI_BENCHMARK_PATH.write_text(
            json.dumps(
                {
                    "benchmarks": [
                        {"id": "safe-tool-use", "prompt": "Use safe commands."}
                    ],
                    "results": [
                        {
                            "benchmark_id": "safe-tool-use",
                            "ollama_name": "gemma3:12b",
                            "status": "executed",
                            "latency_seconds": 2.5,
                            "response": "Inspect before changing anything.",
                        }
                    ],
                }
            )
        )
        dashboard.AI_VALIDATION_PATH.write_text(
            json.dumps(
                {
                    "results": [
                        {
                            "benchmark_id": "safe-tool-use",
                            "ollama_name": "gemma3:12b",
                            "passed_deterministic_checks": True,
                            "findings": [],
                        }
                    ]
                }
            )
        )
        dashboard.AI_REVIEW_PATH.write_text(
            json.dumps(
                {
                    "benchmark_reviews": {
                        "safe-tool-use": {
                            "scores": {"gemma3:12b": 8.5},
                            "findings": {
                                "gemma3:12b": ["Used read-only diagnostics."]
                            },
                        }
                    }
                }
            )
        )

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

    def test_prior_pipeline_decision_does_not_hide_new_review(self):
        dashboard.AI_APPROVAL_PATH.write_text(
            json.dumps(
                {
                    "decision": "rejected",
                    "decision_id": "older-decision",
                    "pipeline_id": "older-pipeline",
                }
            )
        )

        snapshot = dashboard.scorecard_snapshot()
        rendered = dashboard.ai_scorecard()

        self.assertIsNone(snapshot["approval"])
        self.assertIn("Approve Evaluation", rendered)
        self.assertIn("Reject Evaluation", rendered)

    def test_rejected_latest_evaluation_shows_empty_queue(self):
        dashboard.AI_APPROVAL_PATH.write_text(
            json.dumps(
                {
                    "decision": "rejected",
                    "decision_id": "decision-rejected",
                    "pipeline_id": "pipeline-1",
                    "note": "Insufficient evidence",
                }
            )
        )

        rendered = dashboard.ai_scorecard()

        self.assertIn("No pending scorecard reviews", rendered)
        self.assertIn("Check for Next Review", rendered)
        self.assertIn("Insufficient evidence", rendered)
        self.assertNotIn("Approve Evaluation", rendered)
        self.assertNotIn("Reject Evaluation", rendered)

    def test_queue_selects_an_older_undecided_archived_evaluation(self):
        archived = dashboard.AI_EVALUATION_PATH.parent / (
            "evaluation-lab-pipeline-0.json"
        )
        archived.write_text(
            json.dumps(
                {
                    "pipeline_id": "pipeline-0",
                    "created_at": "2026-07-25T10:00:00Z",
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
                    "decision": "rejected",
                    "decision_id": "pipeline-1-rejected",
                    "pipeline_id": "pipeline-1",
                }
            )
        )

        snapshot = dashboard.scorecard_snapshot()
        rendered = dashboard.ai_scorecard()

        self.assertEqual(snapshot["evaluation"]["pipeline_id"], "pipeline-0")
        self.assertEqual(snapshot["pending_count"], 1)
        self.assertIn("Approve Evaluation", rendered)
        self.assertIn("pipeline_id=pipeline-0", rendered)

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

    def test_pending_evaluation_has_direct_decision_buttons(self):
        dashboard.AI_APPROVAL_PATH.unlink()

        rendered = dashboard.ai_scorecard()

        self.assertNotIn('name="confirmation"', rendered)
        self.assertNotIn("Fill approval confirmation", rendered)
        self.assertNotIn("Fill rejection confirmation", rendered)
        self.assertIn(
            'name="pipeline_id" value="pipeline-1"',
            rendered,
        )
        self.assertIn("Clicking the decision button is your confirmation", rendered)
        self.assertIn("automatic routing stays off", rendered)
        self.assertEqual(rendered.count("box-sizing:border-box;"), 4)

    def test_rejection_rejects_a_stale_pipeline(self):
        dashboard.request.form = {"pipeline_id": "older-pipeline"}

        with mock.patch.object(dashboard, "run_scorecard_action") as action:
            response = dashboard.ai_scorecard_reject()

        self.assertIn("The%20evaluation%20changed", response)
        action.assert_not_called()

    def test_successful_rejection_returns_to_clean_scorecard(self):
        dashboard.request.form = {
            "pipeline_id": "pipeline-1",
            "note": "",
        }

        with mock.patch.object(
            dashboard,
            "run_scorecard_action",
            return_value=(True, "rejected"),
        ):
            response = dashboard.ai_scorecard_reject()

        self.assertEqual(response, "/ai-scorecard")

    def test_evidence_page_shows_source_prompt_and_findings(self):
        rendered = dashboard.ai_scorecard_evidence("safe-tool-use")

        self.assertIn("Use safe commands.", rendered)
        self.assertIn("Inspect before changing anything.", rendered)
        self.assertIn("Used read-only diagnostics.", rendered)
        self.assertIn("gemma3:12b", rendered)

    def test_scorecard_links_to_evidence(self):
        rendered = dashboard.ai_scorecard()

        self.assertIn(
            "/ai-scorecard/evidence/safe-tool-use",
            rendered,
        )
        self.assertIn("View Decision Details", rendered)

    def test_promotion_requires_exact_decision_confirmation(self):
        dashboard.request.remote_addr = "127.0.0.1"
        dashboard.request.form = {"confirmation": "PROMOTE wrong"}

        with mock.patch.object(dashboard, "run_scorecard_action") as action:
            response = dashboard.ai_scorecard_promote()

        self.assertIn("Promotion%20confirmation%20did%20not%20match", response)
        action.assert_not_called()


if __name__ == "__main__":
    unittest.main()
