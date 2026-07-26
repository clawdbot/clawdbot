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
    requests.exceptions = types.SimpleNamespace(Timeout=TimeoutError)
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
        dashboard.requests.get.reset_mock(
            side_effect=True,
            return_value=True,
        )
        dashboard.requests.post.reset_mock(
            side_effect=True,
            return_value=True,
        )
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
        dashboard.AI_MODEL_REGISTRY_PATH = config / "model_registry.json"
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
        dashboard.AI_MODEL_REGISTRY_PATH.write_text(
            json.dumps(
                {
                    "models": [
                        {
                            "id": "ollama-gemma3-12b",
                            "display_name": "Gemma 3 12B",
                            "provider": "Local Ollama",
                            "deployment": "local",
                            "status": "production",
                        },
                        {
                            "id": "claude",
                            "display_name": "Claude",
                            "provider": "Anthropic",
                            "deployment": "cloud",
                            "status": "evaluation",
                        },
                    ]
                }
            )
        )
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

    def test_all_models_view_remains_available_after_rejection(self):
        dashboard.AI_APPROVAL_PATH.write_text(
            json.dumps(
                {
                    "decision": "rejected",
                    "decision_id": "decision-rejected",
                    "pipeline_id": "pipeline-1",
                }
            )
        )
        dashboard.request.args = {"view": "all"}

        rendered = dashboard.ai_scorecard()

        self.assertIn("Promotion-Eligible Winners", rendered)
        self.assertIn("All Registered Models", rendered)
        self.assertIn("Gemma 3 12B", rendered)
        self.assertIn("Claude", rendered)
        self.assertIn('class="dashboard-table all-models-table"', rendered)
        self.assertIn("table-layout:fixed", rendered)
        self.assertIn('class="table-scroll"', rendered)
        self.assertIn('class="dashboard-table winners-table"', rendered)
        self.assertIn('class="dashboard-table audit-table"', rendered)
        self.assertIn("Open Approval / Reject Queue", rendered)
        self.assertNotIn("No pending scorecard reviews", rendered)

    def test_navigation_separates_scorecard_and_review_queue(self):
        rendered = dashboard.openclaw_shared_navigation()

        self.assertIn("/ai-scorecard?view=all", rendered)
        self.assertIn(">All Models Scorecard<", rendered)
        self.assertIn(">Review Queue<", rendered)

    def test_generation_model_uses_configured_ollama_generate_endpoint(self):
        response = mock.Mock()
        response.json.return_value = {"response": "Ollama is working correctly."}
        dashboard.requests.post.return_value = response

        result = dashboard.test_model("gemma3:12b")

        self.assertTrue(result["success"])
        dashboard.requests.post.assert_called_once()
        call = dashboard.requests.post.call_args
        self.assertEqual(
            call.args[0],
            f"{dashboard.OLLAMA_HOST}/api/generate",
        )
        self.assertEqual(call.kwargs["json"]["model"], "gemma3:12b")
        self.assertEqual(
            call.kwargs["timeout"],
            dashboard.OLLAMA_TIMEOUT_SECONDS,
        )
        response.raise_for_status.assert_called_once_with()

    def test_embedding_model_uses_embedding_health_check(self):
        response = mock.Mock()
        response.json.return_value = {"embeddings": [[0.1, 0.2, 0.3]]}
        dashboard.requests.post.return_value = response

        result = dashboard.test_model("nomic-embed-text:latest")

        self.assertTrue(result["success"])
        call = dashboard.requests.post.call_args
        self.assertEqual(call.args[0], f"{dashboard.OLLAMA_HOST}/api/embed")
        self.assertEqual(
            call.kwargs["json"],
            {
                "model": "nomic-embed-text:latest",
                "input": "OpenClaw health check",
            },
        )
        self.assertIn("3 dimensions", result["response"])

    def test_completed_generation_with_empty_display_text_is_healthy(self):
        response = mock.Mock()
        response.json.return_value = {"response": "", "done": True}
        dashboard.requests.post.return_value = response

        result = dashboard.test_model("glm-4.7-flash:latest")

        self.assertTrue(result["success"])
        self.assertEqual(result["response"], "Generation check passed")

    def test_model_timeout_is_reported_as_warning_not_failure(self):
        dashboard.requests.post.side_effect = TimeoutError()

        result = dashboard.test_model("glm-4.7-flash:latest")

        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "timeout")
        self.assertIn("did not complete", result["response"])

        ollama = {
            "connected": True,
            "endpoint": "http://m4.example:11434/api/tags",
            "model_names": ["glm-4.7-flash:latest"],
        }
        with (
            mock.patch.object(
                dashboard,
                "MODELS",
                ["glm-4.7-flash:latest"],
            ),
            mock.patch.object(
                dashboard,
                "test_model",
                return_value=result,
            ),
        ):
            rendered = dashboard.model_status_panel_html(
                ollama,
                run_live_checks=True,
            )

        self.assertIn("WARNING:", rendered)
        self.assertNotIn("FAILED:", rendered)

    def test_default_model_status_uses_fast_inventory_without_live_calls(self):
        ollama = {
            "connected": True,
            "endpoint": "http://m4.example:11434/api/tags",
            "model_names": list(dashboard.MODELS),
        }

        with mock.patch.object(dashboard, "test_model") as test_model:
            rendered = dashboard.model_status_panel_html(ollama)

        test_model.assert_not_called()
        self.assertIn("AVAILABLE: Installed generation model", rendered)
        self.assertIn("AVAILABLE: Installed embedding model", rendered)
        self.assertIn("Run Live Model Tests", rendered)
        self.assertIn('action="/model-health"', rendered)

    def test_live_model_test_page_gives_immediate_progress_feedback(self):
        rendered = dashboard.live_model_health_page()

        self.assertIn("Tests are running", rendered)
        self.assertIn('fetch("/api/model-health/live")', rendered)
        self.assertIn("Return to Dashboard", rendered)

    def test_live_model_health_api_returns_structured_results(self):
        ollama = {
            "connected": True,
            "endpoint": "http://m4.example:11434/api/tags",
            "model_names": ["gemma3:12b", "nomic-embed-text:latest"],
        }
        with (
            mock.patch.object(
                dashboard,
                "MODELS",
                ["gemma3:12b", "nomic-embed-text:latest"],
            ),
            mock.patch.object(
                dashboard,
                "get_m4_ollama_status",
                return_value=ollama,
            ),
            mock.patch.object(
                dashboard,
                "test_model",
                side_effect=[
                    {"success": True, "response": "Generation check passed"},
                    {
                        "success": True,
                        "response": "Embedding check passed (768 dimensions)",
                    },
                ],
            ),
        ):
            report = dashboard.live_model_health_api()

        self.assertTrue(report["server_connected"])
        self.assertEqual(len(report["models"]), 2)
        self.assertEqual(report["models"][0]["status"], "success")

    def test_unreachable_server_is_reported_once_without_model_tests(self):
        ollama = {
            "connected": False,
            "endpoint": "http://m4.example:11434/api/tags",
            "error": "connection refused",
        }

        with mock.patch.object(dashboard, "test_model") as test_model:
            rendered = dashboard.model_status_panel_html(ollama)

        test_model.assert_not_called()
        self.assertEqual(rendered.count("AI model server is unreachable"), 1)
        self.assertIn("Individual model tests were skipped", rendered)
        self.assertNotIn("Testing gemma3:12b", rendered)

    def test_ollama_inventory_uses_configured_endpoint(self):
        response = mock.Mock()
        response.json.return_value = {
            "models": [{"name": "gemma3:12b"}, {"name": "nomic-embed-text:latest"}]
        }
        dashboard.requests.get.return_value = response

        result = dashboard.get_m4_ollama_status()

        self.assertTrue(result["connected"])
        self.assertEqual(result["model_count"], 2)
        dashboard.requests.get.assert_called_once_with(
            f"{dashboard.OLLAMA_HOST}/api/tags",
            timeout=5,
        )
        response.raise_for_status.assert_called_once_with()

    def test_routing_telemetry_panel_shows_report_age(self):
        telemetry_dir = Path(self.temp.name) / "ai_intelligence"
        telemetry_dir.mkdir()
        (telemetry_dir / "routing-telemetry-latest.json").write_text(
            json.dumps(
                {
                    "status": "healthy",
                    "configured_versus_observed": {
                        "matched": 2,
                        "drift": 0,
                        "not_observed": 0,
                    },
                    "recent_failover_count": 0,
                    "recent_failure_count": 0,
                }
            ),
            encoding="utf-8",
        )

        with mock.patch.object(dashboard, "REPORT_DIR", telemetry_dir.parent):
            rendered = dashboard.ai_routing_telemetry_panel_html()

        self.assertIn("Report age:", rendered)
        self.assertIn("Updated:", rendered)
        self.assertIn("healthy", rendered)

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
