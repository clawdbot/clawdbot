#!/usr/bin/env python3

"""
RanchBrain AI Intelligence advisory router.

This tool classifies an AI fallback request, asks the AI Intelligence
recommendation engine which model is best suited to the task, and records
the recommendation.

It does not change the production model.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys

from datetime import datetime
from pathlib import Path


BASE = Path("/home/gravesab/ai/projects/openclaw")

RECOMMENDER = (
    BASE
    / "tools/ai_intelligence/recommend.py"
)

REPORT_DIR = (
    BASE
    / "reports/ai_intelligence"
)

LOG_FILE = REPORT_DIR / "advisory-routing.jsonl"


def classify_task(question: str) -> str:
    text = question.lower()

    private_terms = {
        "password",
        "credential",
        "medical",
        "health",
        "glucose",
        "blood pressure",
        "financial",
        "bank",
        "account number",
        "private",
        "personal data",
    }

    home_assistant_terms = {
        "home assistant",
        "automation",
        "entity",
        "yaml",
        "zigbee",
        "z-wave",
        "zwave",
        "ecobee",
        "sensor",
        "smart home",
    }

    linux_terms = {
        "linux",
        "ubuntu",
        "systemd",
        "journalctl",
        "docker",
        "container",
        "postgresql",
        "redis",
        "server",
        "ssh",
        "bash",
        "terminal",
        "openclaw",
        "ollama",
    }

    swift_terms = {
        "swift",
        "swiftui",
        "xcode",
        "ios app",
        "iphone app",
        "ipad app",
        "propertymanager app",
    }

    long_context_terms = {
        "repository",
        "codebase",
        "architecture",
        "refactor",
        "debug this project",
        "analyze these files",
        "long context",
        "implementation plan",
        "system design",
    }

    if any(term in text for term in private_terms):
        return "private_property_data"

    if any(term in text for term in home_assistant_terms):
        return "home_assistant"

    if any(term in text for term in swift_terms):
        return "swift"

    if any(term in text for term in long_context_terms):
        return "long_context_engineering"

    if any(term in text for term in linux_terms):
        return "linux_admin"

    return "routine_local_query"


def get_recommendation(task: str) -> dict[str, object]:
    if not RECOMMENDER.is_file():
        return {
            "task": task,
            "error": f"Recommender not found: {RECOMMENDER}",
        }

    result = subprocess.run(
        [
            sys.executable,
            str(RECOMMENDER),
            "--task",
            task,
        ],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )

    output = (result.stdout or "").strip()
    error = (result.stderr or "").strip()

    if result.returncode != 0:
        return {
            "task": task,
            "error": error or output or (
                f"Recommender exited with code {result.returncode}"
            ),
        }

    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return {
            "task": task,
            "error": "Recommendation output was not valid JSON",
            "raw_output": output[:500],
        }


def write_record(
    question: str,
    task: str,
    recommendation: dict[str, object],
) -> None:
    REPORT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    question_hash = hashlib.sha256(
        question.encode("utf-8")
    ).hexdigest()[:16]

    record = {
        "timestamp": datetime.now().astimezone().isoformat(),
        "mode": "advisory",
        "task": task,
        "question_hash": question_hash,
        "recommendation": recommendation,
        "production_model_changed": False,
    }

    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(record, sort_keys=True) + "\n"
        )


def main() -> int:
    question = " ".join(sys.argv[1:]).strip()

    if not question:
        question = sys.stdin.read().strip()

    if not question:
        return 0

    task = classify_task(question)
    recommendation = get_recommendation(task)
    write_record(
        question,
        task,
        recommendation,
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
