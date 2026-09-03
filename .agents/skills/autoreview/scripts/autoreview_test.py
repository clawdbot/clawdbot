#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import copy
import importlib.util
import io
import json
import os
import runpy
import stat
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


class AutoreviewPriorityTests(unittest.TestCase):
    def test_default_priority_is_p0(self) -> None:
        with mock.patch.object(sys, "argv", ["autoreview"]):
            args = AUTOREVIEW.parse_args()
        self.assertEqual(args.max_priority, "P0")

    def test_priority_filter_preserves_lower_findings_and_provider_verdict(self) -> None:
        report = copy.deepcopy(DRAFT_REPORT)
        AUTOREVIEW.filter_findings_by_priority(report, "P0")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["priority_filtered_findings"], DRAFT_REPORT["findings"])
        for key in ("overall_correctness", "overall_explanation", "overall_confidence"):
            self.assertEqual(report[key], DRAFT_REPORT[key])


class AutoreviewResultScopeTests(unittest.TestCase):
    def test_scope_rejection_preserves_provider_conclusion_and_audit(self) -> None:
        report = copy.deepcopy(DRAFT_REPORT)
        with contextlib.redirect_stderr(io.StringIO()):
            AUTOREVIEW.validate_report(report, Path.cwd(), {"changed.js"}, [])
        self.assertEqual(report["findings"], [])
        for key in ("overall_correctness", "overall_explanation", "overall_confidence"):
            self.assertEqual(report[key], DRAFT_REPORT[key])
        self.assertEqual(report["scope_rejected_findings"], DRAFT_REPORT["findings"])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            AUTOREVIEW.print_report(report)
        self.assertIn("incomplete", output.getvalue())
        self.assertIn("Draft finding", output.getvalue())
        self.assertIn("draft.js:1", output.getvalue())
        self.assertNotIn("clean:", output.getvalue())

    def test_chunk_merge_keeps_rejections_explanations_and_conservative_confidence(self) -> None:
        rejected = copy.deepcopy(DRAFT_REPORT)
        with contextlib.redirect_stderr(io.StringIO()):
            AUTOREVIEW.validate_report(rejected, Path.cwd(), {"changed.js"}, [])
        reports = [("chunk 1/2", copy.deepcopy(FINAL_REPORT)), ("chunk 2/2", rejected)]
        merged = AUTOREVIEW.merge_chunk_reports(reports)
        self.assertEqual(merged["overall_correctness"], "patch is incorrect")
        self.assertEqual(merged["overall_confidence"], 0.2)
        self.assertEqual(len(merged["scope_rejected_findings"]), 1)
        self.assertEqual(merged["pass_reports"][1]["report"], rejected)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            AUTOREVIEW.print_report(merged)
        self.assertIn("draft", output.getvalue())
        self.assertIn("incomplete", output.getvalue())
        self.assertNotIn("clean:", output.getvalue())

    def test_required_finding_must_survive_priority_filter_for_every_pass_count(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P0", require_finding=["Draft finding"])
        for count in (1, 2):
            with self.subTest(count=count), mock.patch.object(
                AUTOREVIEW, "scan_outgoing_review_pack"
            ), mock.patch.object(AUTOREVIEW, "run_engine", return_value=json.dumps(DRAFT_REPORT)):
                reports = AUTOREVIEW.run_review_passes(
                    args, [args], Path.cwd(), ["pack"] * count, {"draft.js"}
                )
            report = reports[0][1] if count == 1 else AUTOREVIEW.merge_chunk_reports(reports)
            self.assertEqual(
                AUTOREVIEW.missing_required_findings(report, args.require_finding), ["Draft finding"]
            )
            self.assertEqual(report["overall_correctness"], "patch is incorrect")
            self.assertTrue(report["priority_filtered_findings"])

    def test_provider_cannot_supply_local_audit_metadata(self) -> None:
        for key in ("scope_rejected_findings", "priority_filtered_findings", "pass_reports", "review_status"):
            report = copy.deepcopy(FINAL_REPORT)
            report[key] = []
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, "unexpected top-level"):
                AUTOREVIEW.validate_report(report, Path.cwd(), set(), [])

    def test_required_finding_survives_merge_deduplication_and_body_prefix(self) -> None:
        first = copy.deepcopy(DRAFT_REPORT)
        second = copy.deepcopy(DRAFT_REPORT)
        second["findings"][0]["body"] = "x" * 1980 + " required tail"
        merged = AUTOREVIEW.merge_chunk_reports([("chunk 1/2", first), ("chunk 2/2", second)])
        self.assertEqual(len(merged["findings"]), 1)
        self.assertEqual(AUTOREVIEW.missing_required_findings(merged, ["required tail"]), [])


class AutoreviewTargetResultTests(unittest.TestCase):
    def setUp(self):
        source = AUTOREVIEW.SourceVersion
        self.record = AUTOREVIEW.MixedPath(
            "src/migrate.py", "synthetic-record",
            source("base-source", "100644", "original()\nkeep()\n"),
            source("index-source", "100644", "obsolete()\nkeep()\n"),
            source("working-source", "100644", "corrected()\nkeep()\nbroken()\n"),
            "synthetic staged delta", "synthetic unstaged delta",
            ((1, "original()"),), ((1, "obsolete()"),), (),
        )

    def finding(self, target="index", side="present", line=1, excerpt=None, **changes):
        source = ((self.record.base if target == "index" else self.record.index)
                  if side == "removed" else getattr(self.record, target))
        if excerpt is None:
            excerpt = source.content.splitlines()[line - 1]
        finding = {
            "title": "Synthetic defect", "body": "A concrete synthetic claim.",
            "priority": "P0", "confidence": 0.8, "category": "bug",
            "code_location": {"file_path": self.record.path, "line": line},
            "source_attribution": {"target": target, "record_id": self.record.identity,
                                   "source_id": source.identity, "side": side,
                                   "column": 1, "excerpt": excerpt},
        }
        finding.update(changes)
        return finding

    def validate(self, findings, available=True):
        report = copy.deepcopy(FINAL_REPORT)
        report["findings"] = copy.deepcopy(findings)
        AUTOREVIEW.validate_report(report, Path.cwd(), {self.record.path}, [], (self.record,),
                                   {self.record.identity} if available else set())
        return report

    def test_explicit_targets_anchors_and_pass_availability(self):
        accepted = [self.finding(), self.finding("working_tree", line=3),
                    self.finding("working_tree", line=2), self.finding(side="removed"),
                    self.finding("working_tree", side="removed")]
        self.assertEqual(self.validate(accepted)["findings"], accepted)
        cases = []
        missing = self.finding()
        missing.pop("source_attribution")
        cases.append((missing, "requires explicit"))
        null = self.finding(source_attribution=None)
        cases.append((null, "requires explicit"))
        for field, value, reason in (
            ("record_id", "wrong", "record identity"),
            ("source_id", "wrong", "source identity"),
            ("column", 1000, "excerpt"),
            ("excerpt", "invented()", "excerpt"),
        ):
            finding = self.finding()
            finding["source_attribution"][field] = value
            cases.append((finding, reason))
        cases.extend([
            (self.finding("working_tree", excerpt="obsolete()"), "excerpt"),
            (self.finding("working_tree", line=900, excerpt="broken()"), "out of range"),
            (self.finding("working_tree", side="removed", line=2), "genuinely removed"),
        ])
        for finding, reason in cases:
            with self.subTest(reason=reason, finding=finding):
                report = self.validate([finding])
                self.assertEqual(report["findings"], [])
                self.assertIn(reason, report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
                self.assertEqual(AUTOREVIEW.review_status(report), "incomplete")
                self.assertEqual(report["overall_correctness"], "patch is correct")
        report = self.validate([self.finding()], available=False)
        self.assertIn("not available", report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
        original = self.record
        for path in (" src/migrate.py", "src/migrate.py ", " "):
            with self.subTest(path=path):
                self.record = original._replace(path=path)
                finding = self.finding()
                self.assertEqual(self.validate([finding])["findings"], [finding])
            self.record = original

    def test_absence_readd_and_removed_side_are_distinct(self):
        absent = AUTOREVIEW.SourceVersion("absent", None, None)
        for target in ("index", "working_tree"):
            with self.subTest(target=target):
                original = self.record
                if target == "index":
                    self.record = original._replace(index=absent, working_tree_removed=())
                else:
                    self.record = original._replace(working_tree=absent)
                present = self.finding(target, excerpt="obsolete()")
                removed = self.finding(target, side="removed")
                report = self.validate([present, removed])
                self.assertEqual(report["findings"], [removed])
                self.assertIn("absent", report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
                self.record = original

        original = self.record
        for target, side, content, line in (
            ("index", "present", "", 1), ("working_tree", "present", "", 1),
            ("index", "present", "before()\n\n", 2), ("working_tree", "present", "before()\n\n", 2),
            ("index", "removed", "\n", 1), ("working_tree", "removed", "\n", 1),
        ):
            with self.subTest(target=target, side=side, content=content):
                owner = ("base" if target == "index" else "index") if side == "removed" else target
                self.record = original._replace(**{owner: getattr(original, owner)._replace(content=content)})
                if side == "removed":
                    self.record = self.record._replace(**{target + "_removed": ((line, ""),)})
                valid = self.finding(target, side=side, line=line, excerpt="")
                self.assertEqual(self.validate([valid])["findings"], [valid])
                invalid = []
                for key, value in (("record_id", "wrong"), ("source_id", "wrong"),
                                   ("column", 2), ("excerpt", "invented")):
                    bad = copy.deepcopy(valid)
                    bad["source_attribution"][key] = value
                    invalid.append(bad)
                bad = copy.deepcopy(valid)
                bad["code_location"]["line"] = 2 if not content else 900
                invalid.append(bad)
                if side == "present" and content:
                    bad = copy.deepcopy(valid)
                    bad["code_location"]["line"] = 1
                    invalid.append(bad)
                for bad in invalid:
                    report = self.validate([bad])
                    self.assertEqual(report["findings"], [])
                    self.assertEqual(AUTOREVIEW.review_status(report), "incomplete")
                self.record = original
        for target in ("index", "working_tree"):
            for side in ("present", "removed"):
                report = self.validate([self.finding(target, side=side, excerpt="")])
                self.assertEqual(report["findings"], [])
            self.record = original._replace(**{target: absent})
            report = self.validate([self.finding(target, excerpt="")])
            self.assertIn("absent", report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
            self.record = original

    def test_title_independent_groups_keep_variants_targets_and_observations(self):
        reports = []
        for index in range(8):
            finding = self.finding(title=f"Index title {index}")
            findings = [finding]
            if index == 7:
                findings += [self.finding(body="Distinct consequence requiring a different fix."),
                             self.finding("working_tree")]
            reports.append((f"pass {index}", self.validate(findings)))
        for selected in (reports, [("single", self.validate([
            finding for _, report in reports for finding in report["findings"]
        ]))]):
            with self.subTest(passes=len(selected)):
                result = AUTOREVIEW.merge_chunk_reports(selected)
                self.assertEqual(len(result["findings"]), 2)
                grouped = result["findings"][0]
                self.assertEqual(len(grouped["claim_variants"]), 2)
                self.assertEqual(len(grouped["claim_variants"][0]["observations"]), 8)
                self.assertEqual(AUTOREVIEW.missing_required_findings(result, ["Index title 7", "different fix"]), [])
                self.assertEqual(len(result["pass_reports"]), len(selected))
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    AUTOREVIEW.print_report(result)
                for text in ("INDEX-only", "WORKING_TREE", "Index title 7", "different fix"):
                    self.assertIn(text, output.getvalue())

    def test_all_engines_keep_raw_reports_before_normalization_and_filters(self):
        captured = AUTOREVIEW.CapturedBundle("delta", {self.record.path}, (self.record,), ())
        prompt = AUTOREVIEW.ReviewPass("synthetic pack", AUTOREVIEW.ReviewChunk("delta", sources=(self.record,)))
        valid = self.finding()
        valid["code_location"]["file_path"] = r".\src\migrate.py"
        stale = self.finding("working_tree", excerpt="obsolete()")
        outside = self.finding(code_location={"file_path": "outside.py", "line": 1})
        provider = {**FINAL_REPORT, "findings": [valid, stale, outside],
                    "overall_correctness": "patch is incorrect", "overall_confidence": 0.43}
        for engine in AUTOREVIEW.ENGINES:
            with self.subTest(engine=engine), mock.patch.object(AUTOREVIEW, "run_engine", return_value=json.dumps(provider)), \
                    mock.patch.object(AUTOREVIEW, "scan_outgoing_review_pack"), \
                    mock.patch.object(AUTOREVIEW, "verify_mixed_sources"), contextlib.redirect_stderr(io.StringIO()):
                report = AUTOREVIEW.run_reviewer(argparse.Namespace(engine=engine, max_priority="P0"),
                                                 Path.cwd(), prompt, captured, [])
            self.assertEqual(report["provider_report"], provider)
            self.assertEqual(report["overall_confidence"], 0.43)
            self.assertEqual(len(report["findings"]), 1)
            self.assertEqual(len(report["scope_rejected_findings"]), 1)
            self.assertEqual(len(report["attribution_rejected_findings"]), 1)
            self.assertEqual(AUTOREVIEW.review_status(report), "incomplete")
            self.assertEqual(report["available_source_records"], [self.record.identity])
        low = self.validate([self.finding(priority="P2")])
        AUTOREVIEW.filter_findings_by_priority(low, "P0")
        self.assertEqual(AUTOREVIEW.missing_required_findings(low, ["Synthetic defect"]), ["Synthetic defect"])
        self.assertEqual(AUTOREVIEW.review_status(low), "filtered")
        for bad in ({}, {**self.finding()["source_attribution"], "column": True}):
            with self.assertRaisesRegex(SystemExit, "source_attribution"):
                self.validate([self.finding(source_attribution=bad)])

def amp_test_stream(
    cwd: Path,
    *,
    tools: list[object] | None = None,
    mcp_servers: list[object] | None = None,
    trigger: str = "Run the isolated autoreview adapter.",
    tool_name: str = "autoreview_generate",
    tool_input: object = None,
    tool_result_id: str = "amp-tool-use",
    tool_error: bool = False,
    tool_result_content: str | None = None,
) -> str:
    if tool_input is None:
        tool_input = {}
    if tool_result_content is None:
        tool_result_content = (
            "Autoreview generation failed." if tool_error else "Adapter completed."
        )
    return "\n".join(
        [
            json.dumps(
                {
                    "type": "system",
                    "subtype": "init",
                    "cwd": str(cwd),
                    "session_id": "amp-test-session",
                    "tools": ["autoreview_generate"] if tools is None else tools,
                    "mcp_servers": [] if mcp_servers is None else mcp_servers,
                    "agent_mode": "medium",
                }
            ),
            json.dumps(
                {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": trigger}],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                }
            ),
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "amp-tool-use",
                                "name": tool_name,
                                "input": tool_input,
                            }
                        ],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                }
            ),
            json.dumps(
                {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_result_id,
                                "content": tool_result_content,
                                "is_error": tool_error,
                            }
                        ],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                }
            ),
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "Completed."}],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                }
            ),
            json.dumps(
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": "Completed.",
                    "session_id": "amp-test-session",
                }
            ),
        ]
    ) + "\n"


def amp_test_plugin_list(plugin_path: Path) -> str:
    return "\n".join(
        [
            f"✓ {plugin_path} active",
            "  tool: autoreview_generate",
            "  agent: autoreview-adapter",
            "  agent mode: autoreview",
        ]
    ) + "\n"


def amp_test_mcp_denial_result(
    command: list[str],
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    skills_root = Path(env["HOME"]) / ".config" / "agents" / "skills"
    probe_roots = list(skills_root.glob("autoreview-mcp-deny-*"))
    if len(probe_roots) != 1:
        raise AssertionError(f"expected one MCP denial probe, found {probe_roots}")
    mcp_config = json.loads((probe_roots[0] / "mcp.json").read_text(encoding="utf-8"))
    probe_name = next(iter(mcp_config))
    return subprocess.CompletedProcess(
        command,
        0,
        "12 tools available\n",
        f"error connecting to {probe_name}: MCP server is not allowed by MCP permissions\n",
    )


class AutoreviewAmpTests(unittest.TestCase):
    def test_amp_bin_cli_option_and_defaults(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            ["autoreview", "--engine", "amp", "--amp-bin", "/tmp/trusted-amp"],
        ):
            args = AUTOREVIEW.parse_args()
        reviewer = AUTOREVIEW.reviewer_args(args)[0]
        self.assertEqual(reviewer.amp_bin, "/tmp/trusted-amp")
        self.assertEqual(reviewer.model, "openai/gpt-5.6-sol")
        self.assertEqual(reviewer.thinking, "high")
        self.assertFalse(reviewer.tools)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_isolation_probe_requires_api_key_and_flags(self) -> None:
        args = argparse.Namespace(amp_bin="amp")
        required_flags = " ".join(
            [
                "--execute",
                "--stream-json",
                "--stream-json-input",
                "--plugin-ready-timeout",
                "--settings-file",
                "--no-ide",
            ]
        )
        with tempfile.TemporaryDirectory(prefix="autoreview-amp-probe-test.") as tmpdir, mock.patch.dict(
            os.environ,
            {"AMP_API_KEY": "test-key"},
            clear=False,
        ), mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/amp",
        ), mock.patch.object(
            AUTOREVIEW,
            "safe_engine_env",
            return_value={},
        ), mock.patch.object(
            AUTOREVIEW,
            "safe_temp_root",
            return_value=Path(tmpdir),
        ), mock.patch.object(
            AUTOREVIEW,
            "run",
            return_value=subprocess.CompletedProcess(["amp", "--help"], 0, required_flags, ""),
        ):
            self.assertEqual(
                AUTOREVIEW.ensure_amp_isolation_supported(args, Path(tmpdir)),
                "/usr/bin/amp",
            )

        with mock.patch.dict(os.environ, {"AMP_API_KEY": ""}, clear=False), mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/amp",
        ):
            with self.assertRaisesRegex(SystemExit, "requires AMP_API_KEY"):
                AUTOREVIEW.ensure_amp_isolation_supported(args, Path("/tmp/repo"))

    def test_amp_isolation_probe_rejects_native_windows(self) -> None:
        args = argparse.Namespace(amp_bin="amp")
        repo = Path("/tmp/repo")
        context = (
            contextlib.nullcontext()
            if os.name == "nt"
            else mock.patch.object(AUTOREVIEW.os, "name", "nt")
        )
        with context:
            with self.assertRaisesRegex(SystemExit, "native Windows"):
                AUTOREVIEW.ensure_amp_isolation_supported(args, repo)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_run_keeps_review_prompt_out_of_outer_agent(self) -> None:
        args = argparse.Namespace(
            amp_bin="amp",
            max_output_chars=2_000_000,
            model="openai/gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
        )
        secret_prompt = "review diff PRIVATE_REVIEW_MARKER_8f3c"
        observed: dict[str, object] = {}

        def fake_preflight(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            runtime_root = Path(str(env["XDG_CONFIG_HOME"])).parent
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            if command[-2:] == ["tools", "list"]:
                observed["mcp_preflight_prompt_exists"] = (
                    runtime_root / "review-prompt.txt"
                ).exists()
                return amp_test_mcp_denial_result(command, env)
            observed["preflight_command"] = command
            observed["preflight_prompt_exists"] = (
                runtime_root / "review-prompt.txt"
            ).exists()
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_plugin_list(plugin_path),
                "",
            )

        def fake_execute(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            observed["command"] = command
            observed["cwd"] = cwd
            observed["input"] = kwargs["input_text"]
            observed["env"] = kwargs["env"]
            env = kwargs["env"]
            assert isinstance(env, dict)
            runtime_root = Path(str(env["XDG_CONFIG_HOME"])).parent
            prompt_path = runtime_root / "review-prompt.txt"
            result_path = runtime_root / "review-result.json"
            settings_path = runtime_root / "settings.json"
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            observed["prompt"] = prompt_path.read_text(encoding="utf-8")
            observed["settings"] = json.loads(settings_path.read_text(encoding="utf-8"))
            observed["plugin"] = plugin_path.read_text(encoding="utf-8")
            observed["plugin_path"] = plugin_path
            observed["workspace"] = list(cwd.iterdir())
            result_path.write_text(json.dumps(FINAL_REPORT), encoding="utf-8")
            result_path.chmod(0o600)
            return subprocess.CompletedProcess(command, 0, amp_test_stream(cwd), "")

        inherited = {
            "AMP_API_KEY": "test-key",
            "AMP_URL": "https://attacker.invalid",
            "NODE_OPTIONS": "--require=/tmp/attack.js",
            "PYTHONPATH": "/tmp/attack",
            "PLUGINS": "inherited-plugins",
        }
        with tempfile.TemporaryDirectory(prefix="autoreview-amp-run-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.dict(os.environ, inherited, clear=False), mock.patch.object(
                AUTOREVIEW,
                "ensure_amp_isolation_supported",
                return_value="/usr/bin/amp",
            ), mock.patch.object(
                AUTOREVIEW,
                "run",
                side_effect=fake_preflight,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_execute,
            ):
                output = AUTOREVIEW.run_amp(args, repo, secret_prompt)

        self.assertEqual(json.loads(output), FINAL_REPORT)
        self.assertFalse(observed["mcp_preflight_prompt_exists"])
        self.assertFalse(observed["preflight_prompt_exists"])
        preflight_command = observed["preflight_command"]
        self.assertIsInstance(preflight_command, list)
        assert isinstance(preflight_command, list)
        self.assertEqual(preflight_command[-2:], ["plugins", "list"])
        command = observed["command"]
        self.assertIsInstance(command, list)
        assert isinstance(command, list)
        self.assertIn("--execute", command)
        self.assertIn("--stream-json-input", command)
        self.assertIn("--settings-file", command)
        self.assertNotIn("--orb-execute", command)
        self.assertEqual(command[command.index("--mode") + 1], "autoreview")
        self.assertNotIn(secret_prompt, " ".join(command))
        self.assertNotIn(secret_prompt, str(observed["input"]))
        self.assertEqual(observed["prompt"], secret_prompt)
        self.assertEqual(observed["workspace"], [])
        settings = observed["settings"]
        self.assertIsInstance(settings, dict)
        assert isinstance(settings, dict)
        self.assertNotIn("amp.tools.disable", settings)
        self.assertNotIn("amp.tools.enable", settings)
        self.assertEqual(settings["amp.updates.mode"], "disabled")
        self.assertEqual(
            settings["amp.mcpPermissions"],
            [
                {"matches": {"command": "*"}, "action": "reject"},
                {"matches": {"url": "*"}, "action": "reject"},
            ],
        )
        plugin = observed["plugin"]
        self.assertIsInstance(plugin, str)
        assert isinstance(plugin, str)
        self.assertIn("amp.ai.generate", plugin)
        self.assertIn("amp.registerTool", plugin)
        self.assertIn("amp.createAgent", plugin)
        self.assertIn('tools: ["autoreview_generate"]', plugin)
        self.assertIn("readFileSync", plugin)
        self.assertNotIn(secret_prompt, plugin)
        env = observed["env"]
        self.assertIsInstance(env, dict)
        assert isinstance(env, dict)
        self.assertEqual(env["AMP_API_KEY"], "test-key")
        self.assertNotIn("AMP_URL", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("PYTHONPATH", env)
        self.assertEqual(env["PLUGINS"], "all")
        plugin_path = observed["plugin_path"]
        self.assertIsInstance(plugin_path, Path)
        assert isinstance(plugin_path, Path)
        self.assertRegex(plugin_path.stem, r"^autoreview-[0-9a-f]{32}$")
        cwd = observed["cwd"]
        self.assertIsInstance(cwd, Path)
        assert isinstance(cwd, Path)
        self.assertNotEqual(cwd.resolve(), repo.resolve())
        self.assertEqual(Path(env["HOME"]).parent, cwd.parent)

    def test_amp_stream_attestation_rejects_bad_events(self) -> None:
        cwd = Path("/tmp/amp-review-empty")
        misplaced_events = [
            json.loads(line) for line in amp_test_stream(cwd).splitlines()
        ]
        tool_use = misplaced_events[2]["message"]["content"].pop()
        misplaced_events[4]["message"]["content"].append(tool_use)
        misplaced = "\n".join(json.dumps(event) for event in misplaced_events) + "\n"
        extra_result_events = [
            json.loads(line) for line in amp_test_stream(cwd).splitlines()
        ]
        extra_result_events[3]["message"]["content"].append(
            {"type": "text", "text": "unexpected"}
        )
        extra_result = (
            "\n".join(json.dumps(event) for event in extra_result_events) + "\n"
        )
        cases = {
            "malformed": "not-json\n",
            "tools": amp_test_stream(cwd, tools=["autoreview_generate", "shell_command"]),
            "mcp": amp_test_stream(cwd, mcp_servers=[{"name": "server"}]),
            "trigger": amp_test_stream(cwd, trigger="untrusted diff"),
            "wrong tool": amp_test_stream(cwd, tool_name="shell_command"),
            "tool input": amp_test_stream(cwd, tool_input={"command": "id"}),
            "tool result": amp_test_stream(cwd, tool_result_id="wrong-id"),
            "unsanitized error": amp_test_stream(
                cwd,
                tool_error=True,
                tool_result_content="provider echoed PRIVATE_REVIEW_MARKER_8f3c",
            ),
            "multiple init": amp_test_stream(cwd).splitlines()[0] + "\n" + amp_test_stream(cwd),
            "multiple result": amp_test_stream(cwd) + amp_test_stream(cwd).splitlines()[-1] + "\n",
            "misplaced tool use": misplaced,
            "extra tool result content": extra_result,
        }
        for label, stream in cases.items():
            with self.subTest(label=label), self.assertRaisesRegex(
                SystemExit,
                "amp isolation attestation failed",
            ):
                AUTOREVIEW.attest_amp_stream(stream, cwd)

        self.assertTrue(AUTOREVIEW.attest_amp_stream(amp_test_stream(cwd), cwd))
        self.assertFalse(
            AUTOREVIEW.attest_amp_stream(amp_test_stream(cwd, tool_error=True), cwd)
        )

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_run_reports_timeout_before_stream_attestation(self) -> None:
        args = argparse.Namespace(
            amp_bin="amp",
            engine_timeout_seconds=0.01,
            max_output_chars=2_000_000,
            model="openai/gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
        )

        def fake_preflight(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            if command[-2:] == ["tools", "list"]:
                return amp_test_mcp_denial_result(command, env)
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_plugin_list(plugin_path),
                "",
            )

        def fake_execute(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            self.assertEqual(kwargs["max_runtime_seconds"], 0.01)
            return subprocess.CompletedProcess(
                command,
                124,
                '{"type":"system","subtype":"init"}\n',
                "amp engine timed out after 0.01s",
            )

        with tempfile.TemporaryDirectory(prefix="autoreview-amp-timeout-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.object(
                AUTOREVIEW,
                "ensure_amp_isolation_supported",
                return_value="/usr/bin/amp",
            ), mock.patch.object(
                AUTOREVIEW,
                "run",
                side_effect=fake_preflight,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_execute,
            ), mock.patch.object(
                AUTOREVIEW,
                "attest_amp_stream",
                side_effect=AssertionError("timeout stream must not be attested"),
            ) as attest:
                with self.assertRaises(SystemExit) as exc_info:
                    AUTOREVIEW.run_amp(args, repo, "review")

        message = str(exc_info.exception)
        self.assertIn("amp engine failed (124)", message)
        self.assertIn("amp engine timed out after 0.01s", message)
        attest.assert_not_called()

    def test_amp_plugin_inventory_attestation_fails_closed(self) -> None:
        cwd = Path("/tmp/amp-review-empty")
        plugin_path = cwd.parent / "config" / "amp" / "plugins" / "autoreview-token.ts"
        valid = amp_test_plugin_list(plugin_path)
        AUTOREVIEW.attest_amp_plugin_inventory(valid, plugin_path, cwd)

        cases = {
            "missing": "",
            "inactive": valid.replace("✓", "✗", 1).replace(" active", " error", 1),
            "other plugin": valid
            + amp_test_plugin_list(plugin_path.with_name("unexpected.ts")),
            "event handler": valid + "  events: agent.start\n",
            "other tool": valid.replace(
                "  agent: autoreview-adapter",
                "  tool: shell_command\n  agent: autoreview-adapter",
            ),
        }
        for label, output in cases.items():
            with self.subTest(label=label), self.assertRaisesRegex(
                SystemExit,
                "amp plugin isolation preflight failed",
            ):
                AUTOREVIEW.attest_amp_plugin_inventory(output, plugin_path, cwd)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_run_surfaces_direct_generation_failure(self) -> None:
        args = argparse.Namespace(
            amp_bin="amp",
            max_output_chars=2_000_000,
            model="openai/gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
        )

        def fake_preflight(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            if command[-2:] == ["tools", "list"]:
                return amp_test_mcp_denial_result(command, env)
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_plugin_list(plugin_path),
                "",
            )

        def fake_execute(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            error_path = Path(str(env["XDG_CONFIG_HOME"])).parent / "review-error.txt"
            error_path.write_text("provider rejected model", encoding="utf-8")
            error_path.chmod(0o600)
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_stream(cwd, tool_error=True),
                "",
            )

        with tempfile.TemporaryDirectory(prefix="autoreview-amp-error-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.object(
                AUTOREVIEW,
                "ensure_amp_isolation_supported",
                return_value="/usr/bin/amp",
            ), mock.patch.object(
                AUTOREVIEW,
                "run",
                side_effect=fake_preflight,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_execute,
            ):
                with self.assertRaisesRegex(SystemExit, "provider rejected model"):
                    AUTOREVIEW.run_amp(args, repo, "review")


class AutoreviewTruffleHogTests(unittest.TestCase):
    def test_refusal_does_not_echo_input_headings_or_scanner_fields(self) -> None:
        marker = "SYNTHETIC_SCAN_SENTINEL_NOT_A_CREDENTIAL"
        headings = [
            f"# Dataset: {marker}",
            f"# Prompt file: {marker}",
            'Source snapshot: ' + json.dumps({"path": marker, "line_count": 0}),
            'Removed source: ' + json.dumps({"path": marker}),
            '# Untracked File\npath: ' + json.dumps(marker),
            f"+++ b/{marker}",
            f"diff --git a/old.txt b/{marker}\n--- a/old.txt\n+++ b/{marker}\n@@ -1 +1 @@\n+example",
        ]
        for heading in headings:
            with self.subTest(heading=heading), tempfile.TemporaryDirectory() as tempdir:
                prompt = "# Dataset: safe-evidence.txt\n" + heading
                lines = [number for number, line in enumerate(prompt.splitlines(), 1) if marker in line]
                output = json.dumps({"SourceMetadata": {"Data": {"Filesystem": {"line": lines[-1]}}},
                                     "Raw": marker, "RawV2": marker})
                with mock.patch.object(AUTOREVIEW, "find_command", return_value="/trusted/trufflehog"), \
                        mock.patch.object(AUTOREVIEW, "run", return_value=subprocess.CompletedProcess(
                            [], AUTOREVIEW.TRUFFLEHOG_FINDINGS_EXIT_CODE, output, marker,
                        )), mock.patch.object(AUTOREVIEW, "run_engine") as provider:
                    with self.assertRaises(SystemExit) as error:
                        AUTOREVIEW.run_reviewer(argparse.Namespace(engine="codex", max_priority="P0"),
                                                 Path(tempdir), prompt, {"change.txt"}, [])
                self.assertNotIn(marker, str(error.exception))
                self.assertIn("remove credential material", str(error.exception))
                provider.assert_not_called()

    def test_scanner_checks_stdin_without_literal_ignore_markers(self) -> None:
        prompt = "unicode \u03c0\r\nsource without suppression instructions\n"
        commands = []
        with tempfile.TemporaryDirectory() as tempdir:
            def scanner(command, cwd, **kwargs):
                commands.append(command[1])
                if command[1] == "filesystem":
                    self.assertEqual(Path(command[2]).read_bytes(), prompt.encode("utf-8"))
                    return subprocess.CompletedProcess(command, 0, "", "")
                self.assertEqual(command[1], "stdin")
                self.assertEqual(kwargs["stdin"].read(), prompt.encode("utf-8"))
                return subprocess.CompletedProcess(command, AUTOREVIEW.TRUFFLEHOG_FINDINGS_EXIT_CODE, "", "")

            with mock.patch.object(AUTOREVIEW, "find_command", return_value="/trusted/trufflehog"), \
                    mock.patch.object(AUTOREVIEW, "run", side_effect=scanner), \
                    mock.patch.object(AUTOREVIEW, "run_engine", return_value=json.dumps(FINAL_REPORT)) as provider:
                with self.assertRaisesRegex(SystemExit, "refusing to send review pack"):
                    AUTOREVIEW.run_reviewer(argparse.Namespace(engine="codex", max_priority="P0"),
                                             Path(tempdir), prompt, {"change.txt"}, [])
            self.assertEqual(commands, ["filesystem", "stdin"])
            provider.assert_not_called()

    def test_binary_stdin_preserves_utf8_and_crlf_bytes(self) -> None:
        payload = "unicode \u03c0\r\nnext\n".encode("utf-8")
        with tempfile.TemporaryDirectory() as tempdir, tempfile.TemporaryFile() as source:
            source.write(payload)
            source.seek(0)
            result = AUTOREVIEW.run(
                [sys.executable, "-c", "import sys; print(sys.stdin.buffer.read().hex())"],
                Path(tempdir), stdin=source,
            )
        self.assertEqual(result.stdout.strip(), payload.hex())

    def test_every_provider_scans_each_pack_and_refuses_scanner_failures(self) -> None:
        for engine in ("codex", "claude", "amp", "pi", "kimi"):
            for failed_source, failure in ((None, None), (None, "missing"),
                                           ("filesystem", "finding"), ("filesystem", "error"),
                                           ("stdin", "finding"), ("stdin", "error")):
                with self.subTest(engine=engine, source=failed_source, failure=failure), tempfile.TemporaryDirectory() as tempdir:
                    repo = Path(tempdir)
                    args = argparse.Namespace(engine=engine, max_priority="P0")
                    prompts = [f"complete pack {index}: unicode \u03c0\r\n-context\n+change\n" for index in range(2)]
                    events: list[tuple[str, str]] = []
                    packs: list[Path] = []

                    def scanner(command, cwd, **kwargs):
                        source = command[1]
                        pack = Path(command[2]) if source == "filesystem" else Path(kwargs["stdin"].name)
                        data = pack.read_bytes() if source == "filesystem" else kwargs["stdin"].read()
                        packs.append(pack)
                        prompt = data.decode("utf-8")
                        self.assertIn(prompt, prompts)
                        self.assertEqual(cwd, pack.parent)
                        if os.name != "nt":
                            self.assertEqual(stat.S_IMODE(pack.stat().st_mode), 0o600)
                            self.assertEqual(stat.S_IMODE(pack.parent.stat().st_mode), 0o700)
                        events.append((source, prompt))
                        code = 0
                        if prompt == prompts[1] and source == failed_source:
                            code = {"finding": AUTOREVIEW.TRUFFLEHOG_FINDINGS_EXIT_CODE, "error": 1}.get(failure, 0)
                        return subprocess.CompletedProcess(command, code, "", "")

                    def provider(_args, _repo, prompt):
                        events.append(("send", prompt))
                        return json.dumps(FINAL_REPORT)

                    with mock.patch.object(AUTOREVIEW, "find_command", return_value="/trusted/trufflehog") as find, \
                            mock.patch.object(AUTOREVIEW, "run", side_effect=scanner), contextlib.ExitStack() as stack:
                        providers = {
                            name: stack.enter_context(mock.patch.object(AUTOREVIEW, f"run_{name}", side_effect=provider))
                            for name in ("codex", "claude", "amp", "pi", "kimi")
                        }
                        AUTOREVIEW.run_reviewer(args, repo, prompts[0], set(), [])
                        if failure == "missing":
                            find.return_value = None
                        if failure:
                            with self.assertRaisesRegex(SystemExit, "refusing to send review pack"):
                                AUTOREVIEW.run_reviewer(args, repo, prompts[1], set(), [])
                        else:
                            AUTOREVIEW.run_reviewer(args, repo, prompts[1], set(), [])
                        for name, call in providers.items():
                            self.assertEqual(call.call_count, (1 if failure else 2) if name == engine else 0)
                    expected = [("filesystem", prompts[0]), ("stdin", prompts[0]), ("send", prompts[0])]
                    if failure != "missing":
                        expected.append(("filesystem", prompts[1]))
                        if failed_source != "filesystem":
                            expected.append(("stdin", prompts[1]))
                    if not failure:
                        expected.append(("send", prompts[1]))
                    self.assertEqual(events, expected)
                    self.assertTrue(all(not pack.parent.exists() for pack in packs))

    def test_scanner_command_requests_verified_and_unknown_results(self) -> None:
        prompt = "review pack with redacted examples only"
        with tempfile.TemporaryDirectory() as tempdir:
            repo = Path(tempdir)

            def run_scanner(
                command: list[str],
                cwd: Path,
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                pack = Path(command[2]) if command[1] == "filesystem" else Path(kwargs["stdin"].name)
                self.assertEqual(cwd, pack.parent)
                data = pack.read_bytes() if command[1] == "filesystem" else kwargs["stdin"].read()
                self.assertEqual(data, prompt.encode("utf-8"))
                self.assertEqual(
                    command[3:] if command[1] == "filesystem" else command[2:],
                    [
                        "--json",
                        "--no-color",
                        "--results=verified,unknown",
                        "--fail",
                        "--fail-on-scan-errors",
                        "--no-update",
                    ],
                )
                self.assertEqual(kwargs["check"], False)
                return subprocess.CompletedProcess(command, 0, "", "")

            with mock.patch.object(
                AUTOREVIEW,
                "find_command",
                return_value="/trusted/trufflehog",
            ), mock.patch.object(AUTOREVIEW, "run", side_effect=run_scanner):
                AUTOREVIEW.scan_outgoing_review_pack(repo, prompt)


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

    def test_kimi_bin_cli_option(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            ["autoreview", "--kimi-bin", "/tmp/trusted-kimi"],
        ):
            args = AUTOREVIEW.parse_args()
        self.assertEqual(args.kimi_bin, "/tmp/trusted-kimi")

    def test_kimi_reviewer_disables_tools(self) -> None:
        args = argparse.Namespace(
            engine="kimi",
            model=None,
            thinking=["on"],
            fallback_model=None,
            codex_config=None,
            codex_speed=None,
            tools=True,
        )

        reviewer = AUTOREVIEW.reviewer_args(args)[0]

        self.assertEqual(reviewer.engine, "kimi")
        self.assertEqual(reviewer.thinking, "on")
        self.assertFalse(reviewer.tools)

    def test_kimi_isolation_requires_current_cli_contract(self) -> None:
        args = argparse.Namespace(kimi_bin="kimi")
        required_flags = " ".join(
            [
                "--agent-file",
                "--skills-dir",
                "--prompt",
                "--output-format",
                "--model",
            ]
        )

        def fake_run(command: list[str], *_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            if "--version" in command:
                return subprocess.CompletedProcess(command, 0, "0.31.1", "")
            return subprocess.CompletedProcess(command, 0, required_flags, "")

        with tempfile.TemporaryDirectory(prefix="autoreview-kimi-probe-test.") as tmpdir, mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/kimi",
        ), mock.patch.object(
            AUTOREVIEW,
            "safe_engine_env",
            return_value={},
        ), mock.patch.object(
            AUTOREVIEW,
            "safe_temp_root",
            return_value=Path(tmpdir),
        ), mock.patch.object(
            AUTOREVIEW,
            "run",
            side_effect=fake_run,
        ):
            self.assertEqual(
                AUTOREVIEW.ensure_kimi_isolation_supported(args, Path(tmpdir)),
                "/usr/bin/kimi",
            )

    def test_kimi_runs_with_empty_tools_skills_and_mcp(self) -> None:
        args = argparse.Namespace(
            kimi_bin="kimi",
            model="kimi-model",
            stream_engine_output=False,
            thinking="on",
        )
        observed: dict[str, object] = {}

        def fake_run(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            observed["command"] = command
            observed["cwd"] = cwd
            observed["env"] = kwargs["env"]
            env = kwargs["env"]
            assert isinstance(env, dict)
            home = Path(str(env["KIMI_CODE_HOME"]))
            observed["agent"] = (home / "reviewer.md").read_text(encoding="utf-8")
            observed["config"] = (home / "config.toml").read_text(encoding="utf-8")
            observed["skills"] = list((home / "skills").iterdir())
            observed["workspace"] = list(cwd.iterdir())
            stream = (
                json.dumps({"role": "meta", "type": "system.version", "version": "0.31.1"})
                + "\n"
                + json.dumps({"role": "assistant", "content": json.dumps(FINAL_REPORT)})
                + "\n"
            )
            return subprocess.CompletedProcess(command, 0, stream, "")

        with tempfile.TemporaryDirectory(prefix="autoreview-kimi-run-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.object(
                AUTOREVIEW,
                "ensure_kimi_isolation_supported",
                return_value="/usr/bin/kimi",
            ), mock.patch.object(
                AUTOREVIEW,
                "load_kimi_review_config",
                return_value=({"telemetry": False}, None),
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_run,
            ):
                output = AUTOREVIEW.run_kimi(args, repo, "review prompt")

        self.assertEqual(json.loads(output), FINAL_REPORT)
        command = observed["command"]
        self.assertIsInstance(command, list)
        assert isinstance(command, list)
        self.assertEqual(command[command.index("--prompt") + 1], "review prompt")
        self.assertEqual(command[command.index("--output-format") + 1], "stream-json")
        self.assertEqual(command[command.index("--model") + 1], "kimi-model")
        self.assertNotIn("--thinking", command)
        agent = observed["agent"]
        self.assertIsInstance(agent, str)
        assert isinstance(agent, str)
        self.assertIn("tools: []", agent)
        self.assertIn("subagents: []", agent)
        config = observed["config"]
        self.assertIsInstance(config, str)
        assert isinstance(config, str)
        self.assertIn("[thinking]", config)
        self.assertIn("enabled = true", config)
        self.assertEqual(observed["skills"], [])
        self.assertEqual(observed["workspace"], [])
        env = observed["env"]
        self.assertIsInstance(env, dict)
        assert isinstance(env, dict)
        self.assertEqual(env["KIMI_DISABLE_TELEMETRY"], "1")
        self.assertEqual(env["KIMI_CODE_NO_AUTO_UPDATE"], "1")
        self.assertNotEqual(Path(str(env["KIMI_CODE_HOME"])), repo)

    def test_codex_config_status_exposes_keys_only(self) -> None:
        args = argparse.Namespace(codex_config=['model_verbosity="low"'])
        self.assertEqual(AUTOREVIEW.codex_config_keys(args), ["model_verbosity"])

    def test_codex_retries_terra_after_sol_access_failure(self) -> None:
        args = argparse.Namespace(
            engine="codex",
            max_priority="P0",
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
        prompt = "complete retry pack: unicode \u03c0\r\n-deleted line\n unchanged context\n"
        for failed_source, failure in ((None, None), (None, "missing"),
                                       ("filesystem", "finding"), ("filesystem", "error"),
                                       ("stdin", "finding"), ("stdin", "error")):
            with self.subTest(source=failed_source, failure=failure), tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir:
                events: list[str] = []
                packs: list[Path] = []

                def scanner(command, _cwd, **kwargs):
                    source = command[1]
                    pack = Path(command[2]) if source == "filesystem" else Path(kwargs["stdin"].name)
                    data = pack.read_bytes() if source == "filesystem" else kwargs["stdin"].read()
                    packs.append(pack)
                    self.assertEqual(data, prompt.encode("utf-8"))
                    events.append(source)
                    code = 0
                    if "gpt-5.6-sol" in events and source == failed_source:
                        code = {"finding": AUTOREVIEW.TRUFFLEHOG_FINDINGS_EXIT_CODE, "error": 1}.get(failure, 0)
                    return subprocess.CompletedProcess(command, code, "", "")

                def fake_run(command, _cwd, **kwargs):
                    self.assertEqual(kwargs["input_text"], prompt)
                    model = command[command.index("--model") + 1]
                    events.append(model)
                    if model == "gpt-5.6-sol":
                        if failure == "missing":
                            find.return_value = None
                        return subprocess.CompletedProcess(
                            command, 1, "",
                            "The model `gpt-5.6-sol` does not exist or you do not have access to it.",
                        )
                    output_path = Path(command[command.index("--output-last-message") + 1])
                    output_path.write_text(json.dumps(FINAL_REPORT))
                    return subprocess.CompletedProcess(command, 0, "", "")

                with mock.patch.object(AUTOREVIEW, "resolve_command", return_value="/usr/bin/codex"), \
                        mock.patch.object(AUTOREVIEW, "ensure_codex_isolation_supported", return_value="/usr/bin/codex"), \
                        mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), \
                        mock.patch.object(AUTOREVIEW, "prepare_codex_runtime_auth", return_value=None), \
                        mock.patch.object(AUTOREVIEW, "find_command", return_value="/trusted/trufflehog") as find, \
                        mock.patch.object(AUTOREVIEW, "run", side_effect=scanner), \
                        mock.patch.object(AUTOREVIEW, "run_with_heartbeat", side_effect=fake_run):
                    if failure:
                        with self.assertRaisesRegex(SystemExit, "refusing to send review pack"):
                            AUTOREVIEW.run_reviewer(args, Path(tmpdir), prompt, set(), [])
                    else:
                        report = AUTOREVIEW.run_reviewer(args, Path(tmpdir), prompt, set(), [])
                        self.assertEqual(report["findings"], [])
                expected = ["filesystem", "stdin", "gpt-5.6-sol"]
                if failure != "missing":
                    expected.append("filesystem")
                    if failed_source != "filesystem":
                        expected.append("stdin")
                if not failure:
                    expected.append("gpt-5.6-terra")
                self.assertEqual(events, expected)
                self.assertTrue(all(not pack.parent.exists() for pack in packs))

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
            (repo / ".env").write_text("ignored environment fixture\n")
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
                "ensure_codex_isolation_supported",
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
        ), mock.patch.object(
            AUTOREVIEW,
            "ensure_codex_isolation_supported",
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
        ), mock.patch.object(
            AUTOREVIEW,
            "ensure_codex_isolation_supported",
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

if __name__ == "__main__":
    unittest.main()
