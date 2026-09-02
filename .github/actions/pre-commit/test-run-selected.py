"""Boundary tests using Workflow Sanity's installed pre-commit runtime."""

import copy
import json
import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from pre_commit.yaml import yaml_dump, yaml_load

RUNNER = Path(__file__).with_name("run-selected.py").resolve()


class SelectedHookTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="pre-commit-selection-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.env = {
            **os.environ, "PRE_COMMIT_HOME": str(self.root / "cache"),
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_ALLOW_PROTOCOL": "file", "PYTHONPATH": str(self.root),
        }
        subprocess.run(["git", "init", "-q", str(self.root)], check=True, env=self.env)
        recorder = self.root / "record.py"
        recorder.write_text(
            "import json, pathlib, sys\n"
            "pathlib.Path('receipt.json').write_text(json.dumps(sys.argv[1:]))\n"
            "raise SystemExit(7 if '--fail' in sys.argv else 0)\n"
        )
        self.hook = {
            "id": "selected", "alias": "audit", "name": "selected", "language": "system",
            "entry": shlex.join([sys.executable, "-I", str(recorder)]),
            "args": ["--policy", "trusted config.yml"], "require_serial": True,
            "files": r"^scan/", "exclude": "hook-excluded", "types": ["file"],
            "types_or": ["yaml", "python"], "exclude_types": ["python"],
        }
        self.missing = {
            "repo": str(self.root / "unreachable-remote"), "rev": "v1.0.0",
            "hooks": [{"id": "unrelated"}],
        }
        self.config = {
            "default_stages": ["pre-commit"], "files": r"\.(ya?ml|py|txt)$",
            "exclude": "global-excluded", "repos": [
                {"repo": "local", "hooks": [self.hook, {
                    **self.hook, "id": "sibling", "alias": "", "args": ["--fail"],
                }]}, self.missing,
            ],
        }

    def run_hook(self, selected="audit", *arguments):
        config = self.root / "config.yaml"
        config.write_text(yaml_dump(self.config))
        return subprocess.run(
            [sys.executable, "-I", str(RUNNER), str(config), selected, *arguments],
            cwd=self.root, env=self.env, capture_output=True, text=True,
        )

    def test_unrelated_initialization_filters_and_isolated_imports(self):
        files = ["scan/yes.yml", "scan/with space.yaml", "scan/hook-excluded.yml",
                 "scan/global-excluded.yml", "scan/no.txt", "scan/no.py", "other/no.yml"]
        for filename in [*files, "scan/not-requested.yml"]:
            target = self.root / filename
            target.parent.mkdir(exist_ok=True)
            target.write_text("fixture\n")
        subprocess.run(["git", "add", "."], cwd=self.root, env=self.env, check=True)
        # Neither the helper nor its pre-commit child may import candidate code.
        for name in ("yaml.py", "pre_commit.py", "sitecustomize.py"):
            (self.root / name).write_text("raise RuntimeError('candidate import')\n")
        original = self.root / "original.yaml"
        original.write_text(yaml_dump(self.config))
        before = subprocess.run(
            [sys.executable, "-I", "-m", "pre_commit", "run", "--config", str(original),
             "audit", "--files", *files],
            cwd=self.root, env=self.env, capture_output=True, text=True,
        )
        self.assertEqual(before.returncode, 3, before.stdout + before.stderr)
        self.assertIn("unreachable-remote", before.stdout)
        self.assertFalse((self.root / "receipt.json").exists())
        result = self.run_hook("audit", "--files", *files)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("Initializing environment", result.stdout)
        self.assertEqual(json.loads((self.root / "receipt.json").read_text()),
                         [*self.hook["args"], *files[:2]])
        self.hook["args"].append("--fail")
        result = self.run_hook("selected", "--all-files")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("- exit code: 7", result.stdout)
        self.assertTrue(result.stderr.endswith("[pre-commit-selected] FAILED (exit 1)\n"))
        self.assertIn("scan/not-requested.yml", json.loads((self.root / "receipt.json").read_text()))

    def test_selected_fetch_failure_and_stage_selection(self):
        result = self.run_hook("unrelated", "--all-files")
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("unreachable-remote", result.stdout)
        self.assertIn("return code: 128", result.stdout)
        self.assertTrue(result.stderr.endswith("[pre-commit-selected] FAILED (exit 3)\n"))
        result = self.run_hook("audit", "--all-files", "--hook-stage", "manual")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("No hook with id `audit` in stage `manual`", result.stdout)

    def test_missing_hook_and_invalid_original_config_fail_before_scan(self):
        for kind in ("missing", "invalid-unselected", "minimum-version"):
            with self.subTest(kind=kind):
                if kind == "invalid-unselected":
                    self.missing["hooks"][0]["types"] = ["invalid-type"]
                if kind == "minimum-version":
                    self.missing["hooks"][0].pop("types")
                    self.config["minimum_pre_commit_version"] = "999.0.0"
                result = self.run_hook("absent" if kind == "missing" else "audit", "--all-files")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn({"missing": "No hook with id or alias 'absent'",
                               "invalid-unselected": "invalid-type",
                               "minimum-version": "999.0.0"}[kind], result.stderr)
                self.assertFalse((self.root / "receipt.json").exists())
                self.assertNotIn("Initializing environment", result.stdout)

    def test_projection_preserves_raw_stanzas_and_all_alias_matches(self):
        config = {
            "minimum_pre_commit_version": "4.6.2", "default_stages": ["manual"],
            "default_install_hook_types": ["pre-push"],
            "default_language_version": {"python": "python3"}, "fail_fast": True,
            "files": r"^scan/", "exclude": "excluded", "ci": {"autofix_prs": False},
            "repos": [
                {"repo": "https://example.invalid/first", "rev": "v6.0.0", "hooks": [
                    {"id": "one", "alias": "audit", "args": ["--config", "/trusted/zizmor.yml"],
                     "files": r"\.yaml$", "exclude": "skip", "types": ["file"],
                     "types_or": ["yaml"], "exclude_types": ["binary"], "stages": ["manual"]},
                    {"id": "other"},
                ]},
                self.missing,
                {"repo": "https://example.invalid/second", "rev": "a" * 40,
                 "hooks": [{"id": "audit"}]},
            ],
        }
        original = copy.deepcopy(config)
        config_path = self.root / "original.yaml"
        config_path.write_text(yaml_dump(config))
        expected = copy.deepcopy(config)
        expected["repos"] = [expected["repos"][0], expected["repos"][2]]
        expected["repos"][0]["hooks"].pop()
        projected_paths = []

        def scan(command):
            self.assertEqual(command[:6], [sys.executable, "-I", "-m", "pre_commit", "run", "--config"])
            self.assertEqual(command[7:], ["audit", "--files", "scan/with space.yaml"])
            projected = Path(command[6])
            projected_paths.append(projected)
            self.assertEqual(yaml_load(projected.read_text()), expected)
            return subprocess.CompletedProcess(command, 17)

        with patch.object(sys, "argv", [str(RUNNER), str(config_path), "audit", "--files", "scan/with space.yaml"]):
            with patch("subprocess.run", side_effect=scan) as child:
                self.assertEqual(runpy.run_path(str(RUNNER))["main"](), 17)
                child.assert_called_once()
        self.assertEqual(yaml_load(config_path.read_text()), original)
        self.assertFalse(projected_paths[0].exists())


if __name__ == "__main__":
    unittest.main()
