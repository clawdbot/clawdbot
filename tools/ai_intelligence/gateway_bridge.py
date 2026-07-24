#!/usr/bin/env python3
"""JSON bridge between the OpenClaw Gateway and AI execution engine."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.ai_intelligence.execution_engine import (
    build_execution_engine_from_environment,
)
from tools.ai_intelligence.routing_models import RoutingRequest


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


def read_request() -> dict[str, Any]:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("Gateway request must be a JSON object")
    return payload


def serialize_result(result: Any) -> dict[str, Any]:
    return {
        "requestId": result.request_id,
        "componentId": result.component_id,
        "status": result.status.value,
        "content": result.content,
        "selectedModelId": result.selected_model_id,
        "attempts": [
            {
                "providerName": attempt.provider_name,
                "modelId": attempt.model_id,
                "status": attempt.status.value,
                "startedAt": attempt.started_at.isoformat(),
                "finishedAt": attempt.finished_at.isoformat(),
                "durationMs": attempt.duration_ms,
                "errorType": attempt.error_type,
                "errorMessage": attempt.error_message,
            }
            for attempt in result.attempts
        ],
    }


def main() -> int:
    load_database_environment()
    payload = read_request()
    result = build_execution_engine_from_environment().execute(
        RoutingRequest(
            component_id=payload["componentId"],
            request_id=payload.get("requestId"),
        ),
        prompt=payload["prompt"],
        system_prompt=payload.get("systemPrompt"),
        timeout_seconds=float(payload.get("timeoutSeconds", 60)),
    )
    json.dump(serialize_result(result), sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"AI Intelligence gateway bridge failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
