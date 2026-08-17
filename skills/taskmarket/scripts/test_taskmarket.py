#!/usr/bin/env python3
"""Tests for the taskmarket OpenClaw skill's CLI wrapper.

Tests exercise the wrapper's exit-code contract and argument handling with a
stub `taskmarket` binary on PATH, so they run offline and deterministically.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "taskmarket.js"


def make_stub(tmpdir, behavior):
    """Write a stub `taskmarket` executable.

    behavior: dict mapping 'exit_code' (int), 'stdout' (str), 'stderr' (str).
    """
    stub = Path(tmpdir) / "taskmarket"
    stub.write_text(
        "#!/bin/sh\n"
        f"echo {json.dumps(behavior.get('stdout', '{}'))}\n"
        f"exit {behavior.get('exit_code', 0)}\n",
        encoding="utf-8",
    )
    stub.chmod(0o755)
    return str(tmpdir)


class TaskmarketCliTest(unittest.TestCase):
    def exec_node(self, *args, stub_dir=None):
        env = dict(os.environ)
        if stub_dir:
            env["PATH"] = stub_dir + os.pathsep + env.get("PATH", "")
        return subprocess.run(
            ["node", str(SCRIPT), *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )

    def test_no_args_prints_usage(self):
        r = self.exec_node()
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage:", r.stderr)

    def test_unknown_action_fails(self):
        r = self.exec_node("frobnicate")
        self.assertEqual(r.returncode, 2)
        self.assertIn("unknown action", r.stderr)

    def test_create_without_confirm_exits_not_authorized(self):
        r = self.exec_node("create", "desc", "5", "24", "crypto")
        self.assertEqual(r.returncode, 3)
        self.assertIn("TASKMARKET_NOT_AUTHORIZED", r.stderr)

    def test_submit_without_confirm_exits_not_authorized(self):
        r = self.exec_node("submit", "0xabc", "msg", "/tmp/f")
        self.assertEqual(r.returncode, 3)
        self.assertIn("TASKMARKET_NOT_AUTHORIZED", r.stderr)

    def test_create_missing_reward_usage(self):
        r = self.exec_node("create", "desc", "--confirm")
        self.assertEqual(r.returncode, 2)
        self.assertIn("create requires", r.stderr)

    def test_submit_missing_file_usage(self):
        r = self.exec_node("submit", "0xabc", "msg", "--confirm")
        self.assertEqual(r.returncode, 2)
        self.assertIn("submit requires", r.stderr)

    def test_browse_forwards_to_cli(self):
        with tempfile.TemporaryDirectory() as td:
            out = json.dumps({
                "ok": True,
                "data": {"tasks": [{
                    "id": "0x1234567890abcdef",
                    "reward": "1000000",
                    "submissionCount": 3,
                    "expiryTime": "2026-08-25T00:00:00.000Z",
                    "description": "Build a thing - Longer description",
                    "status": "open",
                }]},
            })
            stub_dir = make_stub(td, {"exit_code": 0, "stdout": out})
            r = self.exec_node("browse", stub_dir=stub_dir)
            self.assertEqual(r.returncode, 0)
            self.assertIn("reward=$1.00", r.stdout)
            self.assertIn("subs=3", r.stdout)

    def test_review_missing_taskid_usage(self):
        r = self.exec_node("review")
        self.assertEqual(r.returncode, 2)
        self.assertIn("review requires", r.stderr)

    def test_create_confirm_forwards_to_cli(self):
        with tempfile.TemporaryDirectory() as td:
            stub_dir = make_stub(td, {"exit_code": 0, "stdout": '{"ok":true,"data":{"id":"0xabc"}}'})
            r = self.exec_node("create", "desc", "5", "24", "crypto", "--confirm", stub_dir=stub_dir)
            self.assertEqual(r.returncode, 0)
            self.assertIn("0xabc", r.stdout)

    def test_cli_failure_propagates(self):
        with tempfile.TemporaryDirectory() as td:
            stub_dir = make_stub(td, {"exit_code": 1, "stderr": "boom"})
            r = self.exec_node("create", "desc", "5", "24", "--confirm", stub_dir=stub_dir)
            self.assertEqual(r.returncode, 4)


if __name__ == "__main__":
    unittest.main()
