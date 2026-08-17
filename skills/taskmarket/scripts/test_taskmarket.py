#!/usr/bin/env python3
"""Tests for the taskmarket OpenClaw skill's client script (pure logic + CLI behavior)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parent / "taskmarket.js"


class TaskmarketCliTest(unittest.TestCase):
    def exec_node(self, *args, env=None):
        merged = {**os.environ, "PATH": os.environ.get("PATH", "")}
        if env:
            merged.update(env)
        return subprocess.run(
            ["node", str(SCRIPT), *args],
            capture_output=True,
            text=True,
            env=merged,
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

    def test_create_without_key_exits_not_authorized(self):
        env = {k: v for k, v in os.environ.items() if k not in ("TASKMARKET_API_KEY",)}
        r = self.exec_node("create", "t", "d", env=env)
        self.assertEqual(r.returncode, 3)
        self.assertIn("TASKMARKET_API_KEY not set", r.stderr)

    def test_submit_without_key_exits_not_authorized(self):
        env = {k: v for k, v in os.environ.items() if k not in ("TASKMARKET_API_KEY", "TASKMARKET_WORKER_ADDRESS")}
        r = self.exec_node("submit", "0xabc", "msg", env=env)
        self.assertEqual(r.returncode, 3)
        self.assertIn("TASKMARKET_API_KEY not set", r.stderr)

    def test_submit_with_key_but_no_worker_address(self):
        env = {**os.environ, "TASKMARKET_API_KEY": "k-test"}
        env = {k: v for k, v in env.items() if k != "TASKMARKET_WORKER_ADDRESS"}
        r = self.exec_node("submit", "0xabc", "msg", env=env)
        self.assertEqual(r.returncode, 3)
        self.assertIn("TASKMARKET_WORKER_ADDRESS not set", r.stderr)

    def test_create_missing_description_usage(self):
        env = {**os.environ, "TASKMARKET_API_KEY": "k-test"}
        r = self.exec_node("create", "title-only", env=env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("create requires", r.stderr)

    def test_browse_hits_live_api_and_prints_rows(self):
        # Live connectivity test against the public read-only endpoint.
        r = self.exec_node("browse")
        if r.returncode == 4:
            # Network-isolated environments: script must still fail cleanly.
            self.assertIn("browse failed", r.stderr)
            return
        self.assertEqual(r.returncode, 0)
        self.assertIn("reward=", r.stdout)

    def test_browse_json_output_parses(self):
        r = self.exec_node("browse", "--json")
        if r.returncode == 4:
            self.assertIn("browse failed", r.stderr)
            return
        self.assertEqual(r.returncode, 0)
        data = json.loads(r.stdout)
        self.assertIsInstance(data, list)


if __name__ == "__main__":
    unittest.main()
