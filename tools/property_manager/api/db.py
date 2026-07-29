"""PropertyManager DB access.

Prefers TCP via env password. When no password is configured, falls back to
`docker exec postgres psql` (same pattern as export/import scripts on IntelMini).
"""

from __future__ import annotations

import json
import os
import subprocess
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


def use_docker() -> bool:
    if FORCE_DOCKER:
        return True
    return not bool(DB_CONFIG["password"])


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
        result = subprocess.run(
            [
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
                "-F",
                "\t",
                "-c",
                sql,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "psql failed")

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
    result = subprocess.run(
        [
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
            "-c",
            sql,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "psql failed")
    payload = json.loads(result.stdout or "[]")
    if not isinstance(payload, list):
        return []
    return [{k: _jsonable(v) for k, v in row.items()} for row in payload]


def execute_one_json(query: str, params: Any = None) -> dict[str, Any] | None:
    rows = execute_json(query, params)
    return rows[0] if rows else None


def execute(query: str, params: Any = None) -> int:
    sql = _mogrify(query, params)
    result = subprocess.run(
        [
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
            "-c",
            sql,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "psql failed")
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
