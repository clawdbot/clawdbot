#!/usr/bin/env python3
"""Unit tests for docker-exec inflight tracking / drain helpers."""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

API_DIR = Path(__file__).resolve().parents[1] / "api"


def _load_db():
    if str(API_DIR) not in sys.path:
        sys.path.insert(0, str(API_DIR))
    if "db" in sys.modules:
        del sys.modules["db"]
    return importlib.import_module("db")


class DockerExecDrainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = _load_db()
        with self.db._inflight_lock:
            self.db._inflight_procs.clear()

    def test_docker_psql_tracks_and_clears_inflight(self) -> None:
        seen_inflight = {"count": 0}

        class FakeProc:
            def __init__(self) -> None:
                self.returncode = 0
                self._polled = None

            def poll(self):
                return self._polled

            def communicate(self):
                seen_inflight["count"] = self_db.inflight_docker_exec_count()
                self._polled = 0
                return ("ok\n", "")

        self_db = self.db
        fake = FakeProc()

        def fake_popen(*_args, **_kwargs):
            return fake

        with mock.patch.object(self.db.subprocess, "Popen", side_effect=fake_popen):
            result = self.db._docker_psql("SELECT 1")

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "ok\n")
        self.assertGreaterEqual(seen_inflight["count"], 1)
        self.assertEqual(self.db.inflight_docker_exec_count(), 0)

    def test_wait_inflight_returns_when_empty(self) -> None:
        self.assertEqual(self.db.wait_inflight_docker_execs(timeout=1.0), 0)

    def test_wait_inflight_terminates_on_timeout(self) -> None:
        class HangProc:
            def __init__(self) -> None:
                self.returncode = None
                self.terminated = False
                self.killed = False

            def poll(self):
                return 0 if self.killed or self.terminated else None

            def wait(self, timeout=None):
                time.sleep(min(0.05, timeout or 0.05))
                if self.poll() is None:
                    raise subprocess.TimeoutExpired(cmd="hang", timeout=timeout or 0)

            def terminate(self) -> None:
                self.terminated = True
                self.returncode = -15

            def kill(self) -> None:
                self.killed = True
                self.returncode = -9

        hang = HangProc()
        with self.db._inflight_lock:
            self.db._inflight_procs.add(hang)  # type: ignore[arg-type]

        remaining = self.db.wait_inflight_docker_execs(timeout=0.05)
        self.assertTrue(hang.terminated or hang.killed)
        self.assertEqual(remaining, 0)
        self.assertEqual(self.db.inflight_docker_exec_count(), 0)

    def test_slow_db_route_disabled_without_env(self) -> None:
        env = {
            "PROPERTYMANAGER_AUTH_DISABLED": "1",
            "PROPERTYMANAGER_DB_VIA_DOCKER": "1",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("PROPERTYMANAGER_TEST_SLOW_DB_MS", None)
            for name in (
                "auth",
                "db",
                "errors",
                "decimal_utils",
                "meter_schedule",
                "assets_api",
                "mapping_proposals",
                "propertymanager_api",
            ):
                if name in sys.modules:
                    del sys.modules[name]
            import propertymanager_api as api

            client = api.app.test_client()
            response = client.get("/v1/test/slow-db")
            self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
