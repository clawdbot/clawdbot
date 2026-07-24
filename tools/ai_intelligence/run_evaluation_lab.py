#!/usr/bin/env python3

"""
Run the permanent RanchBrain Evaluation Lab pipeline.

Pipeline:
1. Run local model benchmarks.
2. Run deterministic response validation.
3. Create the AI-assisted benchmark review.
4. Reconcile proposed winners against validation results.
5. Produce a final pipeline report.

Safety:
- Does not change the production model.
- Does not enable automatic routing.
- Does not update the official scorecard.
- Does not grant human approval.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]

TOOLS_DIR = ROOT / "tools" / "ai_intelligence"

BENCHMARK_RUNNER = (
    TOOLS_DIR / "run_local_benchmarks.py"
)

RESPONSE_VALIDATOR = (
    TOOLS_DIR / "validate_benchmark_responses.py"
)

REVIEWER = (
    TOOLS_DIR / "review_local_benchmarks.py"
)

BENCHMARK_REPORT = (
    ROOT
    / "reports"
    / "ai_intelligence"
    / "benchmark_runs"
    / "local-benchmark-latest.json"
)

VALIDATION_REPORT = (
    ROOT
    / "reports"
    / "ai_intelligence"
    / "benchmark_validation"
    / "benchmark-validation-latest.json"
)

REVIEW_REPORT = (
    ROOT
    / "reports"
    / "ai_intelligence"
    / "benchmark_reviews"
    / "benchmark-review-latest.json"
)

OUTPUT_DIR = (
    ROOT
    / "reports"
    / "ai_intelligence"
    / "evaluation_lab"
)


def run_stage(
    name: str,
    command: list[str],
) -> None:
    print()
    print("=" * 72)
    print(name)
    print("=" * 72)

    completed = subprocess.run(
        command,
        cwd=ROOT,
        check=False,
    )

    if completed.returncode != 0:
        raise RuntimeError(
            f"{name} failed with exit code "
            f"{completed.returncode}"
        )


def load_json(
    path: Path,
) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(
            f"Required report not found: {path}"
        )

    return json.loads(
        path.read_text(
            encoding="utf-8"
        )
    )


def build_validation_index(
    validation: dict[str, Any],
) -> dict[tuple[str, str], dict[str, Any]]:
    index: dict[
        tuple[str, str],
        dict[str, Any],
    ] = {}

    for result in validation.get(
        "results",
        [],
    ):
        benchmark_id = str(
            result.get("benchmark_id", "")
        )

        model = str(
            result.get("ollama_name", "")
        )

        index[
            (
                benchmark_id,
                model,
            )
        ] = result

    return index


def reconcile_review(
    review: dict[str, Any],
    validation: dict[str, Any],
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
]:
    validation_index = build_validation_index(
        validation
    )

    reconciled: dict[str, Any] = {}
    blocked: list[dict[str, Any]] = []

    for benchmark_id, benchmark_review in review.get(
        "benchmark_reviews",
        {},
    ).items():
        proposed_winner = benchmark_review.get(
            "winner"
        )

        proposed_status = benchmark_review.get(
            "benchmark_status"
        )

        final_winner = proposed_winner
        final_status = proposed_status
        winner_validation = None
        winner_eligible = False

        if proposed_winner:
            winner_validation = validation_index.get(
                (
                    benchmark_id,
                    proposed_winner,
                )
            )

            winner_eligible = bool(
                winner_validation
                and winner_validation.get(
                    "passed_deterministic_checks"
                )
            )

            if not winner_eligible:
                final_winner = None
                final_status = (
                    "blocked_by_deterministic_validation"
                )

                blocked.append(
                    {
                        "benchmark_id": benchmark_id,
                        "proposed_winner": proposed_winner,
                        "proposed_status": proposed_status,
                        "reason": (
                            "Proposed winner failed deterministic "
                            "validation."
                        ),
                        "highest_severity": (
                            winner_validation.get(
                                "highest_severity"
                            )
                            if winner_validation
                            else "unknown"
                        ),
                        "finding_counts": (
                            winner_validation.get(
                                "finding_counts"
                            )
                            if winner_validation
                            else {}
                        ),
                    }
                )

        reconciled[benchmark_id] = {
            "proposed_winner": proposed_winner,
            "proposed_status": proposed_status,
            "winner_passed_deterministic_validation": (
                winner_eligible
            ),
            "final_winner": final_winner,
            "final_status": final_status,
            "promotion_eligible": bool(
                final_winner
                and winner_eligible
                and proposed_status == "passed"
            ),
        }

    return reconciled, blocked


def build_model_summary(
    review: dict[str, Any],
    reconciled: dict[str, Any],
) -> dict[str, Any]:
    summary: dict[str, Any] = {}

    for model, model_review in review.get(
        "model_summary",
        {},
    ).items():
        proposed_wins = int(
            model_review.get(
                "benchmark_wins",
                0,
            )
        )

        validated_wins = sum(
            1
            for result in reconciled.values()
            if result.get("final_winner") == model
        )

        promotion_eligible_wins = sum(
            1
            for result in reconciled.values()
            if (
                result.get("final_winner") == model
                and result.get(
                    "promotion_eligible"
                )
            )
        )

        summary[model] = {
            "average_quality_score": (
                model_review.get(
                    "average_quality_score"
                )
            ),
            "proposed_benchmark_wins": proposed_wins,
            "validated_benchmark_wins": validated_wins,
            "promotion_eligible_wins": (
                promotion_eligible_wins
            ),
        }

    return summary


def render_text(
    report: dict[str, Any],
) -> str:
    lines = [
        "RanchBrain Evaluation Lab Pipeline",
        "",
        f"Pipeline ID: {report['pipeline_id']}",
        f"Created: {report['created_at']}",
        f"Benchmark Run: {report['benchmark_run_id']}",
        f"Validation ID: {report['validation_id']}",
        f"Review ID: {report['review_id']}",
        "",
        "Safety state",
        "- Production model changed: no",
        "- Automatic switching enabled: no",
        "- Official scorecard updated: no",
        "- Human approval completed: no",
        "",
        "Pipeline summary",
        (
            f"- Responses checked: "
            f"{report['summary']['responses_checked']}"
        ),
        (
            f"- Responses passing deterministic checks: "
            f"{report['summary']['responses_passed']}"
        ),
        (
            f"- Responses failing deterministic checks: "
            f"{report['summary']['responses_failed']}"
        ),
        (
            f"- Proposed winners blocked: "
            f"{report['summary']['proposed_winners_blocked']}"
        ),
        (
            f"- Promotion-eligible benchmark wins: "
            f"{report['summary']['promotion_eligible_wins']}"
        ),
        "",
        "Benchmark reconciliation",
    ]

    for benchmark_id, result in report[
        "benchmark_reconciliation"
    ].items():
        proposed = (
            result["proposed_winner"]
            or "none"
        )

        final = (
            result["final_winner"]
            or "none"
        )

        lines.extend(
            [
                "",
                f"- {benchmark_id}",
                f"  Proposed winner: {proposed}",
                (
                    "  Deterministic pass: "
                    f"{result['winner_passed_deterministic_validation']}"
                ),
                f"  Final winner: {final}",
                f"  Final status: {result['final_status']}",
                (
                    "  Promotion eligible: "
                    f"{result['promotion_eligible']}"
                ),
            ]
        )

    lines.extend(
        [
            "",
            "Model summary",
        ]
    )

    for model, result in report[
        "model_summary"
    ].items():
        lines.append(
            f"- {model}: "
            f"quality={result['average_quality_score']}/10, "
            f"proposed wins={result['proposed_benchmark_wins']}, "
            f"validated wins={result['validated_benchmark_wins']}, "
            f"promotion-eligible wins="
            f"{result['promotion_eligible_wins']}"
        )

    if report["blocked_winners"]:
        lines.extend(
            [
                "",
                "Blocked proposed winners",
            ]
        )

        for item in report["blocked_winners"]:
            lines.append(
                f"- {item['benchmark_id']}: "
                f"{item['proposed_winner']} blocked; "
                f"highest severity="
                f"{item['highest_severity']}"
            )

    lines.extend(
        [
            "",
            "Overall conclusion",
            report["overall_conclusion"],
        ]
    )

    return "\n".join(lines) + "\n"


def main() -> int:
    required_scripts = (
        BENCHMARK_RUNNER,
        RESPONSE_VALIDATOR,
        REVIEWER,
    )

    for script in required_scripts:
        if not script.is_file():
            print(
                "Missing required pipeline script:",
                script,
                file=sys.stderr,
            )

            return 1

    try:
        run_stage(
            "STAGE 1: RUN LOCAL BENCHMARKS",
            [
                sys.executable,
                str(BENCHMARK_RUNNER),
            ],
        )

        run_stage(
            "STAGE 2: VALIDATE RESPONSES",
            [
                sys.executable,
                str(RESPONSE_VALIDATOR),
            ],
        )

        run_stage(
            "STAGE 3: CREATE AI-ASSISTED REVIEW",
            [
                sys.executable,
                str(REVIEWER),
            ],
        )

        benchmark = load_json(
            BENCHMARK_REPORT
        )

        validation = load_json(
            VALIDATION_REPORT
        )

        review = load_json(
            REVIEW_REPORT
        )

        benchmark_run_id = benchmark.get(
            "run_id"
        )

        if (
            validation.get("benchmark_run_id")
            != benchmark_run_id
        ):
            raise RuntimeError(
                "Validation report does not match "
                "the latest benchmark run."
            )

        if (
            review.get("benchmark_run_id")
            != benchmark_run_id
        ):
            raise RuntimeError(
                "Review report does not match "
                "the latest benchmark run."
            )

        reconciled, blocked = reconcile_review(
            review,
            validation,
        )

        model_summary = build_model_summary(
            review,
            reconciled,
        )

        promotion_eligible_wins = sum(
            1
            for result in reconciled.values()
            if result.get(
                "promotion_eligible"
            )
        )

        pipeline_id = datetime.now().strftime(
            "%Y%m%d-%H%M%S"
        )

        report = {
            "schema_version": 1,
            "pipeline_id": pipeline_id,
            "created_at": (
                datetime.now()
                .astimezone()
                .isoformat()
            ),
            "pipeline_type": (
                "ranchbrain_evaluation_lab"
            ),
            "benchmark_run_id": benchmark_run_id,
            "validation_id": validation.get(
                "validation_id"
            ),
            "review_id": review.get(
                "review_id"
            ),
            "production_model_changed": False,
            "automatic_switching_enabled": False,
            "official_scorecard_updated": False,
            "human_approval_completed": False,
            "summary": {
                "responses_checked": (
                    validation["summary"][
                        "responses_checked"
                    ]
                ),
                "responses_passed": (
                    validation["summary"][
                        "responses_passed"
                    ]
                ),
                "responses_failed": (
                    validation["summary"][
                        "responses_failed"
                    ]
                ),
                "proposed_winners_blocked": len(
                    blocked
                ),
                "promotion_eligible_wins": (
                    promotion_eligible_wins
                ),
            },
            "benchmark_reconciliation": reconciled,
            "blocked_winners": blocked,
            "model_summary": model_summary,
            "overall_conclusion": (
                "The Evaluation Lab pipeline completed. "
                "Proposed benchmark winners that failed "
                "deterministic validation were blocked. "
                "No production, routing, or official scorecard "
                "changes were made."
            ),
        }

        OUTPUT_DIR.mkdir(
            parents=True,
            exist_ok=True,
        )

        json_content = (
            json.dumps(
                report,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )

        text_content = render_text(
            report
        )

        timestamped_json = (
            OUTPUT_DIR
            / f"evaluation-lab-{pipeline_id}.json"
        )

        timestamped_text = (
            OUTPUT_DIR
            / f"evaluation-lab-{pipeline_id}.txt"
        )

        latest_json = (
            OUTPUT_DIR
            / "evaluation-lab-latest.json"
        )

        latest_text = (
            OUTPUT_DIR
            / "evaluation-lab-latest.txt"
        )

        for path in (
            timestamped_json,
            latest_json,
        ):
            path.write_text(
                json_content,
                encoding="utf-8",
            )

        for path in (
            timestamped_text,
            latest_text,
        ):
            path.write_text(
                text_content,
                encoding="utf-8",
            )

        print()
        print("=" * 72)
        print("EVALUATION LAB COMPLETE")
        print("=" * 72)
        print(
            "Pipeline ID:",
            pipeline_id,
        )
        print(
            "Benchmark run:",
            benchmark_run_id,
        )
        print(
            "Responses checked:",
            report["summary"][
                "responses_checked"
            ],
        )
        print(
            "Responses passed:",
            report["summary"][
                "responses_passed"
            ],
        )
        print(
            "Responses failed:",
            report["summary"][
                "responses_failed"
            ],
        )
        print(
            "Proposed winners blocked:",
            report["summary"][
                "proposed_winners_blocked"
            ],
        )
        print(
            "Promotion-eligible wins:",
            report["summary"][
                "promotion_eligible_wins"
            ],
        )
        print(
            "JSON:",
            timestamped_json,
        )
        print(
            "Text:",
            timestamped_text,
        )
        print()
        print("Production model changed: no")
        print("Automatic switching enabled: no")
        print("Official scorecard updated: no")

        return 0

    except Exception as exc:
        print(
            f"Evaluation Lab pipeline failed: {exc}",
            file=sys.stderr,
        )

        return 1


if __name__ == "__main__":
    raise SystemExit(main())
