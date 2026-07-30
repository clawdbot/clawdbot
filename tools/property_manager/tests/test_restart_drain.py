#!/usr/bin/env python3
"""Integration: in-flight docker-exec request survives full systemd restart.

Gated by ``PROPERTYMANAGER_INTEGRATION_RESTART_DRAIN=1``.

Orchestration:
1. Enable ``PROPERTYMANAGER_TEST_SLOW_DB_MS`` via a temporary systemd drop-in
2. Reload + restart the unit so the gate is live
3. Start a background GET ``/v1/test/slow-db``
4. ``systemctl --user restart propertymanager-api`` while the request is in flight
5. Assert the background request completes HTTP 200
6. Remove the drop-in and restore the service

Does not recreate dashboard/mic services. Preserves bak-pre-gunicorn units.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

UNIT = os.environ.get("PROPERTYMANAGER_SYSTEMD_UNIT", "propertymanager-api.service")
BASE_URL = os.environ.get("PROPERTYMANAGER_API_BASE", "http://127.0.0.1:5062").rstrip("/")
SLOW_MS = int(os.environ.get("PROPERTYMANAGER_TEST_SLOW_DB_MS", "8000"))
DROPIN_DIR = Path.home() / ".config/systemd/user" / f"{UNIT}.d"
DROPIN_FILE = DROPIN_DIR / "zz-restart-drain-test.conf"
EVIDENCE_PATH = Path(
    os.environ.get(
        "PROPERTYMANAGER_RESTART_DRAIN_EVIDENCE",
        "/tmp/pm-restart-drain-evidence.json",
    )
)


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def _systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return _run(["systemctl", "--user", *args], check=check)


def _http_get(path: str, *, timeout: float) -> tuple[int, str]:
    request = urllib.request.Request(f"{BASE_URL}{path}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return int(response.status), body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), body


def _wait_healthy(*, attempts: int = 60, delay: float = 0.5) -> tuple[int, str]:
    """Retry /health across restart races (connection refused while port unbound)."""
    last: tuple[int, str] = (0, "")
    for _ in range(attempts):
        try:
            code, body = _http_get("/health", timeout=5)
            last = (code, body)
            if code == 200:
                return last
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(delay)
    return last


def _write_dropin(ms: int) -> None:
    DROPIN_DIR.mkdir(parents=True, exist_ok=True)
    DROPIN_FILE.write_text(
        "\n".join(
            [
                "# Temporary — PropertyManager restart-drain integration test",
                "[Service]",
                f"Environment=PROPERTYMANAGER_TEST_SLOW_DB_MS={ms}",
                "",
            ]
        ),
        encoding="utf-8",
    )


def _remove_dropin() -> None:
    if DROPIN_FILE.exists():
        DROPIN_FILE.unlink()
    try:
        DROPIN_DIR.rmdir()
    except OSError:
        pass


def main() -> int:
    if os.environ.get("PROPERTYMANAGER_INTEGRATION_RESTART_DRAIN", "").strip() not in {
        "1",
        "true",
        "yes",
    }:
        print(
            "SKIP: set PROPERTYMANAGER_INTEGRATION_RESTART_DRAIN=1 to run "
            "systemd restart-drain integration test"
        )
        return 0

    evidence: dict[str, object] = {
        "unit": UNIT,
        "base_url": BASE_URL,
        "slow_ms": SLOW_MS,
        "steps": [],
    }

    status = _systemctl("is-active", UNIT, check=False)
    if status.stdout.strip() != "active":
        print(f"FAIL: {UNIT} is not active ({status.stdout.strip() or status.stderr.strip()})")
        return 1

    health_code, health_body = _http_get("/health", timeout=10)
    evidence["steps"].append({"health_before": {"code": health_code, "body": health_body[:500]}})
    if health_code != 200:
        print(f"FAIL: /health before test returned {health_code}")
        return 1

    _write_dropin(SLOW_MS)
    evidence["steps"].append({"dropin": str(DROPIN_FILE)})
    try:
        _systemctl("daemon-reload")
        _systemctl("restart", UNIT)
        code, body = _wait_healthy()
        evidence["steps"].append({"health_after_dropin": {"code": code, "body": body[:500]}})
        if code != 200:
            print("FAIL: service did not become healthy after enabling slow-db drop-in")
            return 1

        # Confirm the gated env is visible on the running service without starting a sleep.
        main_pid = _systemctl("show", UNIT, "-p", "MainPID", "--value").stdout.strip()
        env_blob = Path(f"/proc/{main_pid}/environ").read_bytes()
        gate_live = b"PROPERTYMANAGER_TEST_SLOW_DB_MS=" in env_blob
        evidence["steps"].append({"slow_gate_env_live": gate_live, "main_pid": main_pid})
        if not gate_live:
            print("FAIL: PROPERTYMANAGER_TEST_SLOW_DB_MS not present in service environment")
            return 1

        result: dict[str, object] = {"started": time.time()}

        def _bg_request() -> None:
            try:
                code, body = _http_get(
                    "/v1/test/slow-db",
                    timeout=max(90.0, SLOW_MS / 1000.0 + 60.0),
                )
                result["code"] = code
                result["body"] = body[:1000]
            except Exception as exc:  # noqa: BLE001 — capture for evidence
                result["error"] = f"{type(exc).__name__}: {exc}"
            result["finished"] = time.time()

        thread = threading.Thread(target=_bg_request, name="pm-slow-db", daemon=True)
        thread.start()
        # Ensure the request has entered docker-exec before restart.
        time.sleep(min(2.5, max(1.0, SLOW_MS / 1000.0 * 0.2)))
        restart = _systemctl("restart", UNIT, check=False)
        evidence["steps"].append(
            {
                "restart_returncode": restart.returncode,
                "restart_stdout": restart.stdout[-500:],
                "restart_stderr": restart.stderr[-500:],
            }
        )
        thread.join(timeout=max(120.0, SLOW_MS / 1000.0 + 90.0))
        if thread.is_alive():
            evidence["result"] = {"error": "background request still running after join timeout"}
            EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
            print(f"FAIL: slow-db request did not finish; evidence={EVIDENCE_PATH}")
            return 1

        evidence["result"] = result
        EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        code = int(result.get("code") or 0)
        if code != 200:
            print(f"FAIL: slow-db after restart returned {code}; evidence={EVIDENCE_PATH}")
            print(result)
            return 1
        print(f"OK: slow-db request survived restart with HTTP 200; evidence={EVIDENCE_PATH}")
        print(json.dumps(result, indent=2))
        return 0
    finally:
        _remove_dropin()
        _systemctl("daemon-reload", check=False)
        _systemctl("restart", UNIT, check=False)
        _wait_healthy(attempts=40)


if __name__ == "__main__":
    sys.exit(main())
