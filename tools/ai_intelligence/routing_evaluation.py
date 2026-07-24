#!/usr/bin/env python3

"""
Evaluate RanchBrain AI advisory-routing readiness.

This report measures:
- number of advisory observations
- task and model distribution
- malformed or failed recommendations
- privacy-policy compliance
- provisional versus benchmark-backed scoring
- readiness for local-only automatic model switching

The evaluator never changes the production model.
"""

from __future__ import annotations

import argparse
import json

from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]

CONFIG_DIR = ROOT / "config" / "ai_intelligence"
REPORT_DIR = ROOT / "reports" / "ai_intelligence"

LOG_FILE = REPORT_DIR / "advisory-routing.jsonl"
REGISTRY_FILE = CONFIG_DIR / "model_registry.json"
POLICY_FILE = CONFIG_DIR / "routing_policy.json"
SCORECARD_FILE = CONFIG_DIR / "scorecard.json"
BENCHMARK_FILE = CONFIG_DIR / "benchmarks.json"

LATEST_JSON = REPORT_DIR / "routing-evaluation-latest.json"
LATEST_TEXT = REPORT_DIR / "routing-evaluation-latest.txt"


READINESS_GATES = {
    "minimum_total_records": 50,
    "minimum_task_categories": 4,
    "maximum_error_rate_percent": 5.0,
    "minimum_privacy_compliance_percent": 100.0,
    "minimum_local_recommendations": 10,
}


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_records(path: Path) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    malformed = 0

    if not path.is_file():
        return records, malformed

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line:
            continue

        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            malformed += 1
            continue

        if isinstance(value, dict):
            records.append(value)
        else:
            malformed += 1

    return records, malformed


def required_privacy_by_task(
    policy: dict[str, Any],
) -> dict[str, str]:
    output: dict[str, str] = {}

    for rule in policy.get("rules", []):
        task = str(rule.get("task", ""))

        required = rule.get("required_privacy_tier")

        if task and required:
            output[task] = str(required)

    return output


def registry_by_id(
    registry: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    return {
        str(model["id"]): model
        for model in registry.get("models", [])
        if isinstance(model, dict) and model.get("id")
    }


def benchmark_evidence_count(
    benchmarks: dict[str, Any],
) -> int:
    """
    Count only benchmarks with completed, measured evidence.

    A benchmark whose status is merely "defined" or "planned"
    is not evidence.
    """

    entries = benchmarks.get("benchmarks", [])

    completed_statuses = {
        "completed",
        "passed",
        "failed",
        "reviewed",
        "accepted",
    }

    count = 0

    for entry in entries:
        if not isinstance(entry, dict):
            continue

        status = str(
            entry.get("status", "")
        ).strip().lower()

        has_measured_result = any(
            key in entry
            and entry.get(key) not in {
                None,
                "",
                [],
                {},
            }
            for key in (
                "result",
                "score",
                "measured_score",
                "pass",
                "passed",
                "completed_at",
                "evidence",
            )
        )

        if (
            status in completed_statuses
            and has_measured_result
        ):
            count += 1

    return count


def evaluate() -> dict[str, Any]:
    registry = load_json(REGISTRY_FILE)
    policy = load_json(POLICY_FILE)
    scorecard = load_json(SCORECARD_FILE)
    benchmarks = load_json(BENCHMARK_FILE)

    models = registry_by_id(registry)
    privacy_requirements = required_privacy_by_task(policy)

    records, malformed_lines = load_records(LOG_FILE)

    task_counts: Counter[str] = Counter()
    recommendation_counts: Counter[str] = Counter()
    privacy_counts: Counter[str] = Counter()

    recommendation_errors = 0
    unknown_models = 0
    privacy_checks = 0
    privacy_violations = 0
    local_recommendations = 0
    external_recommendations = 0

    for record in records:
        task = str(record.get("task", "unknown"))
        task_counts[task] += 1

        recommendation = record.get("recommendation", {})

        if not isinstance(recommendation, dict):
            recommendation_errors += 1
            continue

        if recommendation.get("error"):
            recommendation_errors += 1
            continue

        model_id = str(
            recommendation.get(
                "recommended_model",
                "unknown",
            )
        )

        recommendation_counts[model_id] += 1

        model = models.get(model_id)

        if model is None:
            unknown_models += 1
            continue

        privacy_tier = str(
            model.get("privacy_tier", "unknown")
        )

        privacy_counts[privacy_tier] += 1

        if privacy_tier == "local":
            local_recommendations += 1
        elif privacy_tier == "external":
            external_recommendations += 1

        required_privacy = privacy_requirements.get(task)

        if required_privacy:
            privacy_checks += 1

            if privacy_tier != required_privacy:
                privacy_violations += 1

    total_records = len(records)

    total_failures = (
        malformed_lines
        + recommendation_errors
        + unknown_models
    )

    attempted_records = total_records + malformed_lines

    error_rate = (
        round(
            total_failures / attempted_records * 100,
            2,
        )
        if attempted_records
        else 0.0
    )

    privacy_compliance = (
        round(
            (
                privacy_checks - privacy_violations
            )
            / privacy_checks
            * 100,
            2,
        )
        if privacy_checks
        else 100.0
    )

    score_status = str(
        scorecard.get(
            "score_status",
            "unknown",
        )
    )

    evidence_count = benchmark_evidence_count(
        benchmarks
    )

    gate_results = {
        "enough_records": (
            total_records
            >= READINESS_GATES["minimum_total_records"]
        ),
        "enough_task_categories": (
            len(task_counts)
            >= READINESS_GATES["minimum_task_categories"]
        ),
        "acceptable_error_rate": (
            error_rate
            <= READINESS_GATES[
                "maximum_error_rate_percent"
            ]
        ),
        "privacy_compliance": (
            privacy_compliance
            >= READINESS_GATES[
                "minimum_privacy_compliance_percent"
            ]
        ),
        "enough_local_recommendations": (
            local_recommendations
            >= READINESS_GATES[
                "minimum_local_recommendations"
            ]
        ),
        "scores_not_provisional": (
            score_status != "provisional"
        ),
        "benchmark_evidence_present": (
            evidence_count > 0
        ),
    }

    ready_for_local_auto = all(
        (
            gate_results["enough_records"],
            gate_results["enough_task_categories"],
            gate_results["acceptable_error_rate"],
            gate_results["privacy_compliance"],
            gate_results["enough_local_recommendations"],
            gate_results["scores_not_provisional"],
            gate_results["benchmark_evidence_present"],
        )
    )

    blockers = [
        gate.replace("_", " ")
        for gate, passed in gate_results.items()
        if not passed
    ]

    return {
        "generated_at": (
            datetime.now().astimezone().isoformat()
        ),
        "mode": "advisory",
        "production_model_changed": False,
        "ready_for_local_automatic_switching": (
            ready_for_local_auto
        ),
        "readiness_gates": READINESS_GATES,
        "gate_results": gate_results,
        "blockers": blockers,
        "observations": {
            "valid_records": total_records,
            "malformed_log_lines": malformed_lines,
            "recommendation_errors": recommendation_errors,
            "unknown_models": unknown_models,
            "error_rate_percent": error_rate,
            "task_categories_seen": len(task_counts),
            "task_counts": dict(
                task_counts.most_common()
            ),
            "recommended_models": dict(
                recommendation_counts.most_common()
            ),
            "privacy_tiers": dict(
                privacy_counts.most_common()
            ),
            "local_recommendations": (
                local_recommendations
            ),
            "external_recommendations": (
                external_recommendations
            ),
            "privacy_checks": privacy_checks,
            "privacy_violations": privacy_violations,
            "privacy_compliance_percent": (
                privacy_compliance
            ),
            "score_status": score_status,
            "benchmark_evidence_records": (
                evidence_count
            ),
        },
    }


def render_text(report: dict[str, Any]) -> str:
    observations = report["observations"]
    gates = report["gate_results"]

    readiness = (
        "READY"
        if report[
            "ready_for_local_automatic_switching"
        ]
        else "NOT READY"
    )

    lines = [
        "RanchBrain AI Routing Evaluation",
        "",
        f"Generated: {report['generated_at']}",
        "Current mode: advisory",
        f"Local automatic switching: {readiness}",
        "Production model changed: no",
        "",
        "Observations",
        (
            "• Valid advisory records: "
            f"{observations['valid_records']}"
        ),
        (
            "• Task categories observed: "
            f"{observations['task_categories_seen']}"
        ),
        (
            "• Local recommendations: "
            f"{observations['local_recommendations']}"
        ),
        (
            "• External recommendations: "
            f"{observations['external_recommendations']}"
        ),
        (
            "• Routing error rate: "
            f"{observations['error_rate_percent']}%"
        ),
        (
            "• Privacy compliance: "
            f"{observations['privacy_compliance_percent']}%"
        ),
        (
            "• Score status: "
            f"{observations['score_status']}"
        ),
        (
            "• Benchmark evidence records: "
            f"{observations['benchmark_evidence_records']}"
        ),
        "",
        "Readiness Gates",
    ]

    for gate, passed in gates.items():
        symbol = "PASS" if passed else "WAIT"
        label = gate.replace("_", " ").title()
        lines.append(f"• {symbol}: {label}")

    lines.extend(
        [
            "",
            "Task Distribution",
        ]
    )

    task_counts = observations["task_counts"]

    if task_counts:
        for task, count in task_counts.items():
            lines.append(f"• {task}: {count}")
    else:
        lines.append("• No advisory records yet")

    lines.extend(
        [
            "",
            "Recommended Models",
        ]
    )

    recommended = observations["recommended_models"]

    if recommended:
        for model, count in recommended.items():
            lines.append(f"• {model}: {count}")
    else:
        lines.append("• No recommendations yet")

    if report["blockers"]:
        lines.extend(
            [
                "",
                "Current Blockers",
            ]
        )

        for blocker in report["blockers"]:
            lines.append(f"• {blocker}")

    lines.extend(
        [
            "",
            "Decision",
            (
                "Remain in advisory mode. Automatic "
                "switching is not enabled by this report."
                if readiness == "NOT READY"
                else
                "Readiness gates are satisfied for a "
                "separate, reviewed local-only activation."
            ),
        ]
    )

    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Evaluate RanchBrain advisory-routing readiness."
        )
    )

    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON instead of the text report.",
    )

    args = parser.parse_args()

    report = evaluate()
    text_report = render_text(report)

    REPORT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    LATEST_JSON.write_text(
        json.dumps(
            report,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    LATEST_TEXT.write_text(
        text_report,
        encoding="utf-8",
    )

    timestamp = datetime.now().strftime(
        "%Y%m%d-%H%M%S"
    )

    archived_json = (
        REPORT_DIR
        / f"routing-evaluation-{timestamp}.json"
    )

    archived_text = (
        REPORT_DIR
        / f"routing-evaluation-{timestamp}.txt"
    )

    archived_json.write_text(
        LATEST_JSON.read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    archived_text.write_text(
        text_report,
        encoding="utf-8",
    )

    if args.json:
        print(
            json.dumps(
                report,
                indent=2,
                sort_keys=True,
            )
        )
    else:
        print(text_report, end="")

    print(f"\nSaved JSON: {LATEST_JSON}")
    print(f"Saved text: {LATEST_TEXT}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
