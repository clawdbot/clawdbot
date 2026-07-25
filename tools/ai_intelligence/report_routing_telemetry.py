#!/usr/bin/env python3
"""Report AI routing usage and failover telemetry for operators."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.ai_intelligence.database import (
    AIIntelligenceDatabase,
    DatabaseConfig,
)
from tools.ai_intelligence.telemetry import (
    format_failover_status_text,
    summarize_failover_status,
)


CREDENTIALS_PATH = (
    Path.home()
    / ".openclaw"
    / "credentials"
    / "ai-intelligence.env"
)
REQUIRED_DATABASE_KEYS = {
    "OPENCLAW_DB_HOST",
    "OPENCLAW_DB_PORT",
    "OPENCLAW_DB_NAME",
    "OPENCLAW_DB_USER",
    "OPENCLAW_DB_PASSWORD",
}
REPORT_DIR = ROOT / "reports" / "ai_intelligence"
TEXT_REPORT = REPORT_DIR / "routing-telemetry-latest.txt"
JSON_REPORT = REPORT_DIR / "routing-telemetry-latest.json"


def load_database_environment() -> None:
    if REQUIRED_DATABASE_KEYS <= os.environ.keys():
        return

    for line in CREDENTIALS_PATH.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if separator and key in REQUIRED_DATABASE_KEYS:
            os.environ.setdefault(key, value)

    missing = sorted(REQUIRED_DATABASE_KEYS - os.environ.keys())
    if missing:
        raise RuntimeError(
            "Missing AI Intelligence database configuration: "
            + ", ".join(missing)
        )


def main() -> int:
    load_database_environment()
    database = AIIntelligenceDatabase(DatabaseConfig.from_env())
    summary = summarize_failover_status(
        drift_rows=database.list_deployment_drift(),
        recent_rows=database.list_recent_observed_usage(limit=20),
    )
    text = format_failover_status_text(summary)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    TEXT_REPORT.write_text(text, encoding="utf-8")
    JSON_REPORT.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(
            f"AI routing telemetry report failed: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1)
