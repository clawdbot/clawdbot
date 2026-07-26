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
    flask.Response = lambda *args, **kwargs: (args, kwargs)
    flask.request = DummyRequest()
    flask.redirect = lambda location: location
    flask.abort = lambda code: (_ for _ in ()).throw(PermissionError(code))
    flask.send_from_directory = lambda *_args, **_kwargs: None
    flask.stream_with_context = lambda function: function
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
    werkzeug_exceptions = types.ModuleType("werkzeug.exceptions")
    werkzeug_exceptions.HTTPException = Exception
    werkzeug_utils = types.ModuleType("werkzeug.utils")
    werkzeug_utils.secure_filename = lambda value: value
    sys.modules["werkzeug"] = werkzeug
    sys.modules["werkzeug.exceptions"] = werkzeug_exceptions
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
        dashboard.REMOTE_BACKUP_REPORT_PATH = (
            reports / "openclaw_remote_backup_verification_status.json"
        )

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
        self.assertIn("window.alert('Nothing to review.');", rendered)
        self.assertNotIn(
            'href="/ai-scorecard"',
            rendered.split("Check for Next Review")[0].rsplit("<", 1)[-1],
        )
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

        self.assertIn('href="/notes"', rendered)
        self.assertIn(">Vault<", rendered)
        self.assertNotIn('href="/ranchbrain/review"', rendered)
        self.assertIn("/ai-scorecard?view=all", rendered)
        self.assertIn(">All Models Scorecard<", rendered)
        self.assertIn(">Review Queue<", rendered)

    def test_notes_has_dedicated_vault_route_and_title(self):
        with mock.patch.object(
            dashboard,
            "ranchbrain_vault_scan",
            return_value={
                "mode": "remote",
                "host": "intelmini",
                "documents": [],
                "error": "",
            },
        ):
            rendered = dashboard.notes_dashboard()

        self.assertIn("<title>RanchBrain Vault</title>", rendered)
        self.assertIn("<h1>📚 RanchBrain Vault</h1>", rendered)
        self.assertIn("No vault documents were found", rendered)
        self.assertIn("Open Postgres note review queue", rendered)

    def test_notes_vault_probe_failure_is_clear_and_non_failing(self):
        with mock.patch.object(
            dashboard,
            "ranchbrain_vault_scan",
            return_value={
                "mode": "remote",
                "host": "intelmini",
                "documents": [],
                "error": "read-only SSH probe unavailable",
            },
        ):
            rendered = dashboard.notes_dashboard()

        self.assertIn("Vault unavailable", rendered)
        self.assertIn("read-only SSH probe unavailable", rendered)

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

    def test_routing_telemetry_explains_development_failover_plainly(self):
        telemetry_dir = Path(self.temp.name) / "ai_intelligence"
        telemetry_dir.mkdir()
        (telemetry_dir / "routing-telemetry-latest.json").write_text(
            json.dumps(
                {
                    "status": "attention",
                    "configured_versus_observed": {
                        "matched": 0,
                        "drift": 1,
                        "not_observed": 8,
                        "rows": [
                            {
                                "component_id": "telegram_ranch_bot",
                                "configured_primary_model": "ollama-hermes3-8b",
                                "latest_observed_model": "ollama-llama3.2-3b",
                                "deployment_status": "drift",
                            }
                        ],
                    },
                    "recent_failover_count": 1,
                    "recent_failure_count": 0,
                    "recent_observations": [
                        {
                            "component_id": "telegram_ranch_bot",
                            "request_id": "dev-fallback-20260725",
                            "failover_occurred": True,
                            "success": True,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        with mock.patch.object(dashboard, "REPORT_DIR", telemetry_dir.parent):
            rendered = dashboard.ai_routing_telemetry_panel_html()

        self.assertIn("Development test recorded", rendered)
        self.assertIn("No action is required", rendered)
        self.assertIn("No failed requests were recorded", rendered)
        self.assertIn("does not mean the component failed", rendered)
        self.assertIn("Telegram Ranch Bot", rendered)
        self.assertIn("Technical details", rendered)

    def test_missing_external_storage_is_not_reported_as_zero_percent(self):
        missing_path = Path(self.temp.name) / "not-mounted"

        disk = dashboard.get_disk_info(
            str(missing_path),
            "External AI Storage",
        )

        self.assertFalse(disk["available"])
        self.assertIsNone(disk["pct_num"])
        self.assertEqual(disk["pct"], "—")
        self.assertEqual(disk["status"], "Not mounted on this host")

    def test_disk_info_parses_portable_df_output(self):
        with mock.patch.object(
            dashboard.subprocess,
            "check_output",
            return_value=(
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                "/dev/test 100G 38G 62G 38% /"
            ),
        ):
            disk = dashboard.get_disk_info("/", "Internal Disk")

        self.assertTrue(disk["available"])
        self.assertEqual(disk["total"], "100G")
        self.assertEqual(disk["used"], "38G")
        self.assertEqual(disk["free"], "62G")
        self.assertEqual(disk["pct_num"], 38)

    def test_remote_external_storage_probe_is_read_only_and_parses_capacity(self):
        remote_output = (
            "/mnt/ai-storage /dev/sda1 ext4\n"
            "Filesystem Size Used Avail Use% Mounted on\n"
            "/dev/sda1 3.6T 23G 3.4T 1% /mnt/ai-storage"
        )
        with mock.patch.object(
            dashboard.subprocess,
            "check_output",
            return_value=remote_output,
        ) as check_output:
            disk = dashboard.get_remote_external_storage_info()

        self.assertTrue(disk["available"])
        self.assertEqual(disk["total"], "3.6T")
        self.assertEqual(disk["used"], "23G")
        self.assertEqual(disk["free"], "3.4T")
        self.assertEqual(disk["pct_num"], 1)
        self.assertEqual(disk["source"], "/dev/sda1")
        arguments = check_output.call_args.args[0]
        self.assertIsInstance(arguments, list)
        self.assertIn("BatchMode=yes", arguments)
        self.assertNotIn("shell", check_output.call_args.kwargs)
        remote_command = arguments[-1]
        self.assertIn("findmnt", remote_command)
        self.assertIn("df -P -h", remote_command)
        self.assertNotIn("mount ", remote_command)

    def test_remote_storage_probe_failure_is_non_destructive_fallback(self):
        with mock.patch.object(
            dashboard.subprocess,
            "check_output",
            side_effect=TimeoutError(),
        ):
            disk = dashboard.get_remote_external_storage_info()

        self.assertFalse(disk["available"])
        self.assertEqual(disk["status"], "Intel Mini probe unavailable")
        self.assertIsNone(disk["pct_num"])

    def test_backup_remote_probe_uses_read_only_ssh_inventory(self):
        snapshot = {
            "host": "intelmini",
            "checked_at": "2026-07-26T20:00:00-05:00",
            "backups": [],
            "history": [],
            "qnap": {"mounted": True},
        }
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps(snapshot),
            stderr="",
        )
        with mock.patch.object(
            dashboard.subprocess,
            "run",
            return_value=completed,
        ) as run:
            result = dashboard.backup_center_remote_probe()

        self.assertEqual(result["host"], "intelmini")
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[0], "ssh")
        self.assertIn("BatchMode=yes", arguments)
        self.assertIn(
            f"{dashboard.INTELMINI_STORAGE_USER}@"
            f"{dashboard.INTELMINI_STORAGE_HOST}",
            arguments,
        )
        self.assertEqual(run.call_args.kwargs["timeout"], 20)

    def test_m4_time_machine_probe_reports_current_backup(self):
        output = """Andrew-M4-Max
Backup session status:
{
    Running = 0;
}
OPENCLAW_LATEST_BACKUP
/Volumes/.timemachine/id/2026-07-26-131055.backup/2026-07-26-131055.backup
OPENCLAW_DESTINATION
Name          : MacTimeMachine
Kind          : Network
"""
        completed = mock.Mock(returncode=0, stdout=output, stderr="")
        current = dashboard.datetime(2026, 7, 26, 14, 0, 0)
        with (
            mock.patch.object(
                dashboard.subprocess,
                "run",
                return_value=completed,
            ) as run,
            mock.patch.object(
                dashboard,
                "datetime",
                wraps=dashboard.datetime,
            ) as datetime_mock,
        ):
            datetime_mock.now.return_value = current
            result = dashboard.backup_center_m4_time_machine()

        self.assertTrue(result["found"])
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["status_label"], "Current")
        self.assertIn("MacTimeMachine", result["content"])
        self.assertIn("Expected Frequency: Daily", result["content"])
        arguments = run.call_args.args[0]
        self.assertIn("tmutil status", arguments[-1])
        self.assertIn("tmutil latestbackup", arguments[-1])
        self.assertNotIn("tmutil startbackup", arguments[-1])

    def test_backup_center_uses_remote_inventory_and_safe_controls(self):
        now = 1785110400.0
        snapshot = {
            "host": "intelmini",
            "checked_at": "2026-07-26T20:00:00-05:00",
            "backups": [
                {
                    "key": "production",
                    "label": "OpenClaw Production",
                    "directory": "/mnt/ai-storage/openclaw-backups",
                    "filename": "openclaw-checkpoint-current.tar.gz",
                    "timestamp_epoch": now,
                    "size": "135.2 MB",
                    "status": "available",
                },
                {
                    "key": "development",
                    "label": "OpenClaw Development",
                    "directory": "/mnt/ai-storage/openclaw-backups/dev",
                    "filename": "openclaw-dev-backup-current.tar.gz",
                    "timestamp_epoch": now,
                    "size": "68.2 MB",
                    "status": "available",
                },
                {
                    "key": "dashboard",
                    "label": "Dashboard and PropertyManager",
                    "directory": (
                        "/mnt/ai-storage/openclaw-backups/"
                        "dashboard-property-backups"
                    ),
                    "filename": "dashboard-property-backup-current.tar.gz",
                    "timestamp_epoch": now,
                    "size": "9.3 MB",
                    "status": "available",
                },
            ],
            "history": [],
            "qnap": {
                "mounted": True,
                "path": "/mnt/qnap-backup",
                "total": "1.0 TB",
                "used": "100.0 GB",
                "free": "900.0 GB",
                "percent_number": 10,
            },
        }
        with (
            mock.patch.object(
                dashboard,
                "backup_center_remote_probe",
                return_value=snapshot,
            ),
            mock.patch.object(dashboard.time, "time", return_value=now),
        ):
            rendered = dashboard.backup_recovery_center()

        self.assertIn("openclaw-checkpoint-current.tar.gz", rendered)
        self.assertIn("Mounted on Intel Mini", rendered)
        self.assertIn("Run Development Backup Now", rendered)
        self.assertNotIn("Run Production Backup Now", rendered)
        self.assertNotIn("Run Dashboard Backup Now", rendered)
        self.assertIn("Production write actions remain disabled", rendered)

    def test_remote_verification_writes_development_report(self):
        snapshot = {
            "host": "intelmini",
            "checked_at": "2026-07-26T20:00:00-05:00",
            "backups": [
                {
                    "label": "OpenClaw Production",
                    "status": "verified",
                    "checksum_status": "verified",
                }
            ],
        }
        with mock.patch.object(
            dashboard,
            "backup_center_remote_probe",
            return_value=snapshot,
        ) as probe:
            response = dashboard.backup_recovery_verify()

        self.assertIn("result=success", response)
        probe.assert_called_once_with(verify=True)
        report = json.loads(
            dashboard.REMOTE_BACKUP_REPORT_PATH.read_text()
        )
        self.assertEqual(report["host"], "intelmini")
        self.assertEqual(report["verified_count"], 1)

    def test_production_backup_action_is_blocked_in_development(self):
        with mock.patch.object(dashboard.subprocess, "run") as run:
            response = dashboard.backup_recovery_run("production")

        self.assertIn(
            "Production+backup+actions+are+disabled+in+development",
            response,
        )
        run.assert_not_called()

    def test_ranchbrain_uses_existing_development_database_credentials(self):
        missing_chat_env = Path(self.temp.name) / "chat-agent.env"
        development_env = Path(self.temp.name) / "ai-intelligence-dev.env"
        development_env.write_text(
            "\n".join(
                [
                    "OPENCLAW_DB_HOST=127.0.0.1",
                    "OPENCLAW_DB_PORT=55432",
                    "OPENCLAW_DB_NAME=openclaw_ai_dev",
                    "OPENCLAW_DB_USER=openclaw_ai",
                    "OPENCLAW_DB_PASSWORD=test-only",
                ]
            ),
            encoding="utf-8",
        )

        with mock.patch.object(
            dashboard,
            "RANCHBRAIN_ENV_FILES",
            (missing_chat_env, development_env),
        ):
            values = dashboard.load_ranchbrain_env()

        self.assertEqual(values["OPENCLAW_DB_PORT"], "55432")
        self.assertEqual(values["OPENCLAW_DB_NAME"], "openclaw_ai_dev")

    def test_ranchbrain_missing_schema_is_clear_and_non_failing(self):
        with (
            mock.patch.object(
                dashboard,
                "ranchbrain_schema_is_ready",
                return_value=False,
            ),
            mock.patch.object(dashboard, "get_ranchbrain_counts") as counts,
        ):
            rendered = dashboard.ranchbrain_dashboard()

        counts.assert_not_called()
        self.assertIn("Development Database Setup Required", rendered)
        self.assertIn("long_term_memory", rendered)
        self.assertIn("No production data was queried or copied", rendered)
        self.assertNotIn("connection refused", rendered.lower())

    def test_ranchbrain_schema_migration_matches_consumers(self):
        migration = (
            MODULE_PATH.parents[1]
            / "ranchbrain"
            / "migrations"
            / "001_create_long_term_memory.sql"
        )
        sql = migration.read_text(encoding="utf-8")

        self.assertIn("CREATE TABLE IF NOT EXISTS public.long_term_memory", sql)
        self.assertIn("id BIGSERIAL PRIMARY KEY", sql)
        self.assertIn("agent_name TEXT NOT NULL", sql)
        self.assertIn("category TEXT NOT NULL", sql)
        self.assertIn("content TEXT NOT NULL", sql)
        self.assertIn("source TEXT NOT NULL", sql)
        self.assertIn("embedding vector(768)", sql)
        self.assertIn("created_at TIMESTAMPTZ NOT NULL", sql)

    def test_ranchbrain_review_action_uses_development_database_env(self):
        completed = mock.Mock(returncode=0)
        development_env = {
            "OPENCLAW_DB_HOST": "127.0.0.1",
            "OPENCLAW_DB_PORT": "55432",
            "OPENCLAW_DB_NAME": "openclaw_ai_dev",
            "OPENCLAW_DB_USER": "openclaw_ai",
            "OPENCLAW_DB_PASSWORD": "development-only",
        }
        with (
            mock.patch.object(
                dashboard,
                "load_ranchbrain_env",
                return_value=development_env,
            ),
            mock.patch.object(
                dashboard.subprocess,
                "run",
                return_value=completed,
            ) as run,
        ):
            success = dashboard.run_review_action("approve", "12")

        self.assertTrue(success)
        self.assertEqual(
            run.call_args.kwargs["env"]["OPENCLAW_DB_NAME"],
            "openclaw_ai_dev",
        )
        self.assertEqual(
            run.call_args.kwargs["env"]["OPENCLAW_DB_PORT"],
            "55432",
        )

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
