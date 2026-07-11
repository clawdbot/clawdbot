#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("autoreview")
LOADER = SourceFileLoader("autoreview_module", str(SCRIPT_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
AUTOREVIEW = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(AUTOREVIEW)


FINAL_REPORT = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "clean",
    "overall_confidence": 0.9,
}

DRAFT_REPORT = {
    "findings": [
        {
            "title": "Draft finding",
            "body": "draft",
            "priority": "P3",
            "confidence": 0.2,
            "category": "maintainability",
            "code_location": {"file_path": "draft.js", "line": 1},
        }
    ],
    "overall_correctness": "patch is incorrect",
    "overall_explanation": "draft",
    "overall_confidence": 0.2,
}


class AutoreviewCursorTests(unittest.TestCase):
    def test_extract_json_prefers_terminal_result_event(self) -> None:
        stream = "\n".join(
            [
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(DRAFT_REPORT)}]},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "subtype": "success",
                        "result": json.dumps(FINAL_REPORT),
                        "session_id": "session-id",
                        "request_id": "request-id",
                    }
                ),
            ]
        )
        self.assertEqual(AUTOREVIEW.extract_json(stream), FINAL_REPORT)

    def test_extract_json_can_fallback_to_assistant_message(self) -> None:
        stream = json.dumps(
            {
                "type": "assistant",
                "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(FINAL_REPORT)}]},
            }
        )
        self.assertEqual(AUTOREVIEW.extract_json(stream), FINAL_REPORT)

    def test_extract_json_does_not_fallback_past_bad_terminal_result(self) -> None:
        stream = "\n".join(
            [
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(FINAL_REPORT)}]},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "subtype": "success",
                        "result": "not json",
                    }
                ),
            ]
        )
        with self.assertRaises(SystemExit) as exc_info:
            AUTOREVIEW.extract_json(stream)
        self.assertIn("review engine result was not structured JSON", str(exc_info.exception))


class AutoreviewCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.home_dir = tempfile.TemporaryDirectory(prefix="autoreview-test-home.")
        cls.home_patch = mock.patch.object(Path, "home", return_value=Path(cls.home_dir.name))
        cls.home_patch.start()
        cls.home_keys = ("HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH")
        cls.old_home_env = {key: os.environ.get(key) for key in cls.home_keys}
        os.environ["HOME"] = cls.home_dir.name
        os.environ["USERPROFILE"] = cls.home_dir.name
        os.environ.pop("HOMEDRIVE", None)
        os.environ.pop("HOMEPATH", None)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.home_patch.stop()
        for key, value in cls.old_home_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.home_dir.cleanup()

    def test_harness_rejects_disabled_cursor_engine(self) -> None:
        harness_path = SCRIPT_PATH.with_name("test-review-harness.py")
        namespace = runpy.run_path(str(harness_path))
        with self.assertRaises(SystemExit):
            namespace["parse_args"](["--engine", "cursor"])

    def test_cursor_agent_bin_cli_alias(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            ["autoreview", "--cursor-agent-bin", "/tmp/legacy-cursor"],
        ):
            args = AUTOREVIEW.parse_args()
        self.assertEqual(args.cursor_bin, "/tmp/legacy-cursor")

    def test_cursor_agent_bin_env_alias(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"CURSOR_AGENT_BIN": "/tmp/legacy-cursor"},
            clear=False,
        ):
            os.environ.pop("CURSOR_BIN", None)
            with mock.patch.object(sys, "argv", ["autoreview"]):
                args = AUTOREVIEW.parse_args()
        self.assertEqual(args.cursor_bin, "/tmp/legacy-cursor")

    def test_cursor_agent_reviewer_alias_normalizes_to_cursor(self) -> None:
        self.assertEqual(
            AUTOREVIEW.parse_reviewer_token("cursor-agent:auto"),
            ("cursor", "auto", None),
        )

    def test_cursor_agent_keyed_option_normalizes_to_cursor(self) -> None:
        self.assertEqual(
            AUTOREVIEW.parse_keyed_options(["cursor-agent=auto"], "model"),
            (None, {"cursor": "auto"}),
        )

    def test_codex_config_status_exposes_keys_only(self) -> None:
        args = argparse.Namespace(codex_config=['model_verbosity="low"'])
        self.assertEqual(AUTOREVIEW.codex_config_keys(args), ["model_verbosity"])

    def test_codex_retries_terra_after_sol_access_failure(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model="gpt-5.6-terra",
            model="gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        models: list[str] = []

        def fake_run(command: list[str], *_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            model = command[command.index("--model") + 1]
            models.append(model)
            if model == "gpt-5.6-sol":
                return subprocess.CompletedProcess(
                    command,
                    1,
                    "",
                    "The model `gpt-5.6-sol` does not exist or you do not have access to it.",
                )
            output_path = Path(command[command.index("--output-last-message") + 1])
            output_path.write_text(json.dumps(FINAL_REPORT))
            return subprocess.CompletedProcess(command, 0, "", "")

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir, mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/codex",
        ), mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), mock.patch.object(
            AUTOREVIEW,
            "prepare_codex_runtime_auth",
            return_value=None,
        ), mock.patch.object(
            AUTOREVIEW,
            "run_with_heartbeat",
            side_effect=fake_run,
        ):
            output = AUTOREVIEW.run_codex(args, Path(tmpdir), "review")

        self.assertEqual(json.loads(output), FINAL_REPORT)
        self.assertEqual(models, ["gpt-5.6-sol", "gpt-5.6-terra"])

    def test_codex_runs_outside_repo_with_bundle_only_workspace(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model=None,
            model="gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        observed: dict[str, object] = {}

        def fake_run(
            command: list[str],
            cwd: Path,
            *_args: object,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            observed["cwd"] = cwd
            observed["command"] = command
            observed["command_cwd"] = Path(command[command.index("-C") + 1])
            observed["workspace_entries"] = list(cwd.iterdir())
            observed["env"] = kwargs["env"]
            output_path = Path(command[command.index("--output-last-message") + 1])
            output_path.write_text(json.dumps(FINAL_REPORT))
            return subprocess.CompletedProcess(command, 0, "", "")

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-workspace-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".env").write_text("OPENAI_API_KEY=ignored-secret\n")
            with mock.patch.dict(
                os.environ,
                {"CODEX_HOME": ""},
                clear=False,
            ), mock.patch.object(
                AUTOREVIEW,
                "resolve_command",
                return_value="/usr/bin/codex",
            ), mock.patch.object(
                AUTOREVIEW,
                "codex_auth_config_flags",
                return_value=[],
            ), mock.patch.object(
                AUTOREVIEW,
                "prepare_codex_runtime_auth",
                return_value=None,
            ), mock.patch.object(
                AUTOREVIEW,
                "codex_source_home",
                return_value=None,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_run,
            ):
                output = AUTOREVIEW.run_codex(args, repo, "review")

            self.assertEqual(json.loads(output), FINAL_REPORT)
            observed_cwd = observed["cwd"]
            command_cwd = observed["command_cwd"]
            self.assertIsInstance(observed_cwd, Path)
            self.assertIsInstance(command_cwd, Path)
            assert isinstance(observed_cwd, Path)
            assert isinstance(command_cwd, Path)
            self.assertNotEqual(observed_cwd.resolve(), repo.resolve())
            self.assertEqual(observed_cwd, command_cwd)
            self.assertEqual(observed["workspace_entries"], [])
            env = observed["env"]
            self.assertIsInstance(env, dict)
            assert isinstance(env, dict)
            self.assertNotEqual(env["HOME"], os.environ.get("HOME"))
            self.assertEqual(env["USERPROFILE"], env["HOME"])
            self.assertNotEqual(env.get("CODEX_HOME"), str(repo.resolve()))
            self.assertEqual(Path(env["CODEX_HOME"]).name, "codex-home")
            self.assertNotEqual(env["CODEX_HOME"], str((Path.home() / ".codex").resolve()))
            self.assertIn("features.shell_snapshot=false", observed["command"])
            self.assertIn("features.hooks=false", observed["command"])
            self.assertIn("features.plugins=false", observed["command"])
            self.assertIn("skills.include_instructions=false", observed["command"])

    def test_codex_does_not_fallback_after_unrelated_failure(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model="gpt-5.6-terra",
            model="gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        models: list[str] = []

        def fake_run(command: list[str], *_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            models.append(command[command.index("--model") + 1])
            return subprocess.CompletedProcess(command, 1, "", "network timeout")

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir, mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/codex",
        ), mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), mock.patch.object(
            AUTOREVIEW,
            "prepare_codex_runtime_auth",
            return_value=None,
        ), mock.patch.object(
            AUTOREVIEW,
            "run_with_heartbeat",
            side_effect=fake_run,
        ):
            with self.assertRaisesRegex(SystemExit, "network timeout"):
                AUTOREVIEW.run_codex(args, Path(tmpdir), "review")

        self.assertEqual(models, ["gpt-5.6-sol"])

    def test_codex_does_not_fallback_after_model_capacity_failure(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model="gpt-5.6-terra",
            model="gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        models: list[str] = []

        def fake_run(command: list[str], *_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            models.append(command[command.index("--model") + 1])
            return subprocess.CompletedProcess(
                command,
                1,
                "",
                "model_not_available: gpt-5.6-sol is temporarily unavailable due to capacity",
            )

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir, mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/codex",
        ), mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), mock.patch.object(
            AUTOREVIEW,
            "prepare_codex_runtime_auth",
            return_value=None,
        ), mock.patch.object(
            AUTOREVIEW,
            "run_with_heartbeat",
            side_effect=fake_run,
        ):
            with self.assertRaisesRegex(SystemExit, "temporarily unavailable"):
                AUTOREVIEW.run_codex(args, Path(tmpdir), "review")

        self.assertEqual(models, ["gpt-5.6-sol"])

    def test_codex_access_fallback_ignores_structured_output_text(self) -> None:
        result = subprocess.CompletedProcess(
            ["codex"],
            1,
            '{"type":"agent_message","text":"gpt-5.6-sol does not exist or you do not have access"}',
            '{"type":"agent_message","message":"gpt-5.6-sol does not exist or you do not have access"}',
        )

        self.assertFalse(
            AUTOREVIEW.codex_model_access_failure(result, "gpt-5.6-sol")
        )

    def test_codex_access_fallback_accepts_terminal_error_event(self) -> None:
        result = subprocess.CompletedProcess(
            ["codex"],
            1,
            '{"type":"error","message":"gpt-5.6-sol does not exist or you do not have access"}',
            "",
        )

        self.assertTrue(
            AUTOREVIEW.codex_model_access_failure(result, "gpt-5.6-sol")
        )

    def test_codex_access_fallback_accepts_account_model_list_error(self) -> None:
        result = subprocess.CompletedProcess(
            ["codex"],
            1,
            "",
            (
                "The model gpt-5.6-sol does not appear in the list of models "
                "available to your account"
            ),
        )

        self.assertTrue(
            AUTOREVIEW.codex_model_access_failure(result, "gpt-5.6-sol")
        )

    def test_codex_access_fallback_ignores_plain_stdout(self) -> None:
        message = "gpt-5.6-sol does not exist or you do not have access"
        stdout_result = subprocess.CompletedProcess(["codex"], 1, message, "")
        stderr_result = subprocess.CompletedProcess(["codex"], 1, "", message)

        self.assertFalse(
            AUTOREVIEW.codex_model_access_failure(stdout_result, "gpt-5.6-sol")
        )
        self.assertTrue(
            AUTOREVIEW.codex_model_access_failure(stderr_result, "gpt-5.6-sol")
        )

    def test_extract_json_accepts_dict_result_payload(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": FINAL_REPORT,
            "session_id": "session-id",
            "request_id": "request-id",
        }
        self.assertEqual(AUTOREVIEW.extract_json(json.dumps(payload)), FINAL_REPORT)

    def test_extract_json_rejects_result_string_with_preamble(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": "Inspecting the diff first.\n" + json.dumps(FINAL_REPORT),
        }
        with self.assertRaisesRegex(SystemExit, "result was not structured JSON"):
            AUTOREVIEW.extract_json(json.dumps(payload))

    def test_retry_filter_only_matches_parse_failures(self) -> None:
        self.assertTrue(AUTOREVIEW.is_structured_output_failure("review engine returned non-JSON output: nope"))
        self.assertTrue(AUTOREVIEW.is_structured_output_failure("review engine result was not structured JSON:\nnope"))
        self.assertFalse(AUTOREVIEW.is_structured_output_failure("review JSON missing required key: findings"))
        self.assertFalse(AUTOREVIEW.is_structured_output_failure("finding 0 has invalid priority"))

    def test_cursor_workspace_instructions_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=False,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine is unavailable", str(exc_info.exception))

    def test_cursor_local_mcp_requires_explicit_approval(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".cursor").mkdir()
            (repo / ".cursor" / "mcp.json").write_text("{}\n")
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine is unavailable", str(exc_info.exception))

    def test_cursor_local_hooks_are_always_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".cursor").mkdir()
            (repo / ".cursor" / "hooks.json").write_text("{}\n")
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine is unavailable", str(exc_info.exception))

    def test_cursor_local_permissions_are_always_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".cursor").mkdir()
            (repo / ".cursor" / "cli.json").write_text("{}\n")
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine is unavailable", str(exc_info.exception))

    def test_cursor_is_disabled_without_repo_only_read_sandbox(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            root = Path(tmpdir)
            repo = root / "repo"
            repo.mkdir()
            cursor_bin = root / "cursor-agent"
            AUTOREVIEW.write_executable(cursor_bin, AUTOREVIEW.fake_cursor_script())
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin=str(cursor_bin),
                model=None,
                stream_engine_output=False,
            )
            with mock.patch.object(AUTOREVIEW, "cursor_global_hook_paths", return_value=[]):
                with self.assertRaisesRegex(SystemExit, "Cursor read permissions"):
                    AUTOREVIEW.run_cursor(args, repo, "prompt")

    def test_cursor_engine_fails_closed_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-e2e.") as tmpdir:
            root = Path(tmpdir)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "AutoReview Test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "autoreview@example.invalid"], cwd=repo, check=True)
            source = repo / "example.txt"
            source.write_text("before\n")
            subprocess.run(["git", "add", "example.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "test: seed fixture"], cwd=repo, check=True)
            source.write_text("after\n")

            cursor_bin = root / "cursor-agent"
            record_path = root / "record.json"
            AUTOREVIEW.write_executable(cursor_bin, AUTOREVIEW.fake_cursor_script())
            env = os.environ.copy()
            env.update(
                {
                    "AUTOREVIEW_FAKE_RECORD": str(record_path),
                    "AUTOREVIEW_FAKE_CURSOR_INVOCATIONS": str(root / "cursor-invocations.jsonl"),
                    "GIT_CONFIG_GLOBAL": str(root / "hostile-gitconfig"),
                    "NODE_OPTIONS": "--require=hostile.js",
                    "PYTHONPATH": str(root / "hostile-python"),
                    "PATH": f"{repo}{os.pathsep}{env.get('PATH', '')}",
                    "HOME": str(root),
                    "USERPROFILE": str(root),
                }
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--mode",
                    "local",
                    "--engine",
                    "cursor",
                    "--cursor-bin",
                    str(cursor_bin),
                    "--cursor-allow-workspace-instructions",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Cursor read permissions", result.stderr)
            self.assertFalse(record_path.exists())


if __name__ == "__main__":
    unittest.main()
