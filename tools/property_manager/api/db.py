"""PropertyManager DB access.

Prefers TCP via env password. When no password is configured, falls back to
`docker exec postgres psql` (same pattern as export/import scripts on IntelMini).

Process / Gunicorn safety
-------------------------
Default path (``PROPERTYMANAGER_DB_VIA_DOCKER=1`` or no password) is
**docker-exec-per-query**: each call spawns ``docker exec … psql`` and does not
keep a shared DB connection. That is safe across Gunicorn sync workers and
forks (no connection pool, no post-fork shared sockets).

TCP mode (``psycopg2.connect`` via ``connect()``) opens a **new** connection per
``connect()`` call. Callers must not cache connections across requests or share
them across worker processes. Prefer short-lived connections inside the request
handler; do not store connections on module globals.

Importing this module does not open connections, run migrations, or mutate data.
Migrations remain an explicit operator action.

Graceful shutdown / docker-exec drain
-------------------------------------
In-flight ``docker exec`` children are tracked in this module. Gunicorn
``worker_exit`` waits for them (up to ``graceful_timeout``). systemd must use
``KillMode=mixed`` so ``KillSignal=SIGQUIT`` reaches only the Gunicorn master —
default ``control-group`` would SIGQUIT docker-exec children immediately and
yield HTTP 500 on in-flight requests. After ``TimeoutStopSec``, remaining
cgroup processes are SIGKILLed. ``wait_inflight_docker_execs`` terminates then
kills any leftover tracked procs so they are never orphaned indefinitely.
Prefer ``systemctl reload`` (HUP) for near-zero downtime; full restart still
drains in-flight docker-exec work within the graceful window.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def _load_password() -> str:
    for key in ("PROPERTYMANAGER_DB_PASSWORD", "OPENCLAW_DB_PASSWORD", "PGPASSWORD"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    env_file = os.environ.get(
        "PROPERTYMANAGER_DB_ENV_FILE",
        os.path.expanduser("~/.config/openclaw/db.env"),
    )
    path = os.path.expanduser(env_file)
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'").strip('"')
                if key in (
                    "PROPERTYMANAGER_DB_PASSWORD",
                    "OPENCLAW_DB_PASSWORD",
                    "PGPASSWORD",
                ) and value:
                    return value
    return ""


DB_CONFIG = {
    "host": os.environ.get(
        "PROPERTYMANAGER_DB_HOST",
        os.environ.get("OPENCLAW_DB_HOST", "127.0.0.1"),
    ),
    "port": int(
        os.environ.get(
            "PROPERTYMANAGER_DB_PORT",
            os.environ.get("OPENCLAW_DB_PORT", "5432"),
        )
    ),
    "dbname": os.environ.get(
        "PROPERTYMANAGER_DB_NAME",
        os.environ.get("OPENCLAW_DB_NAME", "openclaw"),
    ),
    "user": os.environ.get(
        "PROPERTYMANAGER_DB_USER",
        os.environ.get("OPENCLAW_DB_USER", "openclaw"),
    ),
    "password": _load_password(),
}

DOCKER_CONTAINER = os.environ.get("PROPERTYMANAGER_POSTGRES_CONTAINER", "postgres")
FORCE_DOCKER = os.environ.get("PROPERTYMANAGER_DB_VIA_DOCKER", "").strip() in {
    "1",
    "true",
    "yes",
}

_inflight_lock = threading.Lock()
_inflight_procs: set[subprocess.Popen[str]] = set()


def use_docker() -> bool:
    if FORCE_DOCKER:
        return True
    return not bool(DB_CONFIG["password"])


def inflight_docker_exec_count() -> int:
    """Return the number of tracked in-flight docker-exec processes."""
    with _inflight_lock:
        return sum(1 for proc in _inflight_procs if proc.poll() is None)


def wait_inflight_docker_execs(*, timeout: float | None = None) -> int:
    """Wait for tracked docker-exec children during worker drain.

    Returns the number of processes still alive after the wait (0 on success).
    On timeout, terminate then kill remaining tracked procs so they are not
    orphaned indefinitely.
    """
    if timeout is None:
        timeout = float(os.environ.get("PROPERTYMANAGER_API_GRACEFUL_TIMEOUT", "90"))
    deadline = time.monotonic() + max(0.0, float(timeout))

    while True:
        with _inflight_lock:
            alive = [proc for proc in _inflight_procs if proc.poll() is None]
        if not alive:
            return 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            alive[0].wait(timeout=min(0.5, remaining))
        except subprocess.TimeoutExpired:
            continue

    with _inflight_lock:
        leftover = [proc for proc in list(_inflight_procs) if proc.poll() is None]
    for proc in leftover:
        try:
            proc.terminate()
        except OSError:
            pass
    kill_deadline = time.monotonic() + 1.0
    for proc in leftover:
        wait_left = kill_deadline - time.monotonic()
        if wait_left <= 0:
            break
        try:
            proc.wait(timeout=wait_left)
        except subprocess.TimeoutExpired:
            pass
    for proc in leftover:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        with _inflight_lock:
            _inflight_procs.discard(proc)
    return sum(1 for proc in leftover if proc.poll() is None)


def _docker_psql(
    sql: str,
    *,
    field_separator: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run one psql statement via docker exec (same argv as legacy callers)."""
    cmd = [
        "docker",
        "exec",
        "-i",
        DOCKER_CONTAINER,
        "psql",
        "-U",
        DB_CONFIG["user"],
        "-d",
        DB_CONFIG["dbname"],
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
    ]
    if field_separator is not None:
        cmd.extend(["-F", field_separator])
    cmd.extend(["-c", sql])
    # Track Popen explicitly so worker_exit can wait. Do not start a new session
    # (that would detach/orphan children across worker death).
    proc: subprocess.Popen[str] = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=False,
    )
    with _inflight_lock:
        _inflight_procs.add(proc)
    try:
        stdout, stderr = proc.communicate()
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    finally:
        with _inflight_lock:
            _inflight_procs.discard(proc)


def test_slow_sleep(seconds: float) -> None:
    """Test-only helper: block inside docker-exec via ``pg_sleep``.

    Clamped to 30s. Used by ``GET /v1/test/slow-db`` when
    ``PROPERTYMANAGER_TEST_SLOW_DB_MS`` is set.
    """
    clamped = max(0.0, min(float(seconds), 30.0))
    # Literal seconds only (clamped float) — never interpolate untrusted input.
    result = _docker_psql(f"SELECT pg_sleep({clamped})")
    _raise_psql_failure(result)


def _raise_psql_failure(result: subprocess.CompletedProcess[str]) -> None:
    """Map docker-exec/psql failures, including shutdown interruption, to RuntimeError."""
    if result.returncode == 0:
        return
    # Negative returncode = killed by signal (common when Gunicorn drains/kills a worker).
    if result.returncode < 0:
        sig = -result.returncode
        try:
            sig_name = signal.Signals(sig).name
        except ValueError:
            sig_name = str(sig)
        raise RuntimeError(
            f"psql interrupted by {sig_name} during docker exec "
            "(prefer systemctl reload; worker drain uses KillMode=mixed + graceful_timeout)"
        )
    raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "psql failed")


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, Decimal):
        text = format(value, "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return text
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, memoryview):
        return bytes(value).decode("utf-8", errors="replace")
    return value


def _decode_cell(value: str | None) -> Any:
    if value is None or value == "":
        return None
    if value in ("t", "true"):
        return True
    if value in ("f", "false"):
        return False
    if value.startswith("{") or value.startswith("["):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


class DockerCursor:
    """Minimal RealDictCursor-compatible wrapper over docker exec psql."""

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []
        self.rowcount = -1

    def execute(self, query: str, params: Any = None) -> None:
        sql = _mogrify(query, params)
        result = _docker_psql(sql, field_separator="\t")
        if result.returncode != 0:
            _raise_psql_failure(result)

        text = result.stdout
        # For SELECT ... RETURNING / SELECT, parse rows. Mutations may return empty.
        if not text.strip():
            self._rows = []
            self.rowcount = 0
            return

        # Prefer JSON array mode when query asks for it via wrapper.
        if text.lstrip().startswith("[") or text.lstrip().startswith("{"):
            payload = json.loads(text)
            if isinstance(payload, dict):
                self._rows = [payload]
            elif isinstance(payload, list):
                self._rows = payload
            else:
                self._rows = []
            self.rowcount = len(self._rows)
            return

        lines = [line for line in text.splitlines() if line != ""]
        # Non-SELECT commands often print "UPDATE 1" etc.
        if len(lines) == 1 and lines[0].split()[0] in {"INSERT", "UPDATE", "DELETE", "CREATE", "ALTER"}:
            parts = lines[0].split()
            self._rows = []
            self.rowcount = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            return

        # Expect headerless TSV only when caller uses json_agg path; otherwise treat as bare values.
        self._rows = []
        self.rowcount = 0

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)

    def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None


class DockerConnection:
    def __enter__(self) -> DockerConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self, cursor_factory: Any = None) -> DockerCursor:
        return DockerCursor()

    def commit(self) -> None:
        return None


def _mogrify(query: str, params: Any) -> str:
    if params is None:
        return query
    import psycopg2.extensions

    def adapt(value: Any) -> str:
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        if isinstance(value, (int, float, Decimal)):
            return str(value)
        if isinstance(value, (datetime, date)):
            adapted = psycopg2.extensions.adapt(value.isoformat())
            adapted.encoding = "utf8"
            return adapted.getquoted().decode("utf8")
        if isinstance(value, uuid.UUID):
            adapted = psycopg2.extensions.adapt(str(value))
            adapted.encoding = "utf8"
            return adapted.getquoted().decode("utf8")
        if isinstance(value, (dict, list)):
            adapted = psycopg2.extensions.adapt(json.dumps(value))
            adapted.encoding = "utf8"
            return adapted.getquoted().decode("utf8")
        adapted = psycopg2.extensions.adapt(value)
        if hasattr(adapted, "encoding"):
            adapted.encoding = "utf8"
        return adapted.getquoted().decode("utf8")

    if isinstance(params, dict):
        rendered = query
        # Longest keys first so %(id)s does not eat %(identity)s-style names.
        for key in sorted(params.keys(), key=len, reverse=True):
            rendered = rendered.replace(f"%({key})s", adapt(params[key]))
        return rendered
    if isinstance(params, (list, tuple)):
        parts = query.split("%s")
        if len(parts) - 1 != len(params):
            raise ValueError("parameter count mismatch")
        out = parts[0]
        for index, part in enumerate(parts[1:]):
            out += adapt(params[index]) + part
        return out
    raise TypeError("unsupported params type")


def execute_json(query: str, params: Any = None) -> list[dict[str, Any]]:
    """Run a SELECT and return list[dict] via json_agg."""
    wrapped = f"SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM ({query}) q"
    sql = _mogrify(wrapped, params)
    result = _docker_psql(sql)
    if result.returncode != 0:
        _raise_psql_failure(result)
    payload = json.loads(result.stdout or "[]")
    if not isinstance(payload, list):
        return []
    return [{k: _jsonable(v) for k, v in row.items()} for row in payload]


def execute_one_json(query: str, params: Any = None) -> dict[str, Any] | None:
    rows = execute_json(query, params)
    return rows[0] if rows else None


def execute(query: str, params: Any = None) -> int:
    sql = _mogrify(query, params)
    result = _docker_psql(sql)
    if result.returncode != 0:
        _raise_psql_failure(result)
    text = (result.stdout or "").strip()
    if not text:
        return 0
    first = text.splitlines()[0]
    parts = first.split()
    if parts and parts[0] in {"INSERT", "UPDATE", "DELETE"} and len(parts) > 1 and parts[1].isdigit():
        return int(parts[1])
    return 0


def connect():
    if use_docker():
        return DockerConnection()
    import psycopg2

    return psycopg2.connect(**DB_CONFIG)
