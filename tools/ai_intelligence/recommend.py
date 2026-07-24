#!/usr/bin/env python3
"""Deterministic, production-safe model recommendation engine."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config" / "ai_intelligence"


class ConfigurationError(RuntimeError):
    """Raised when AI Intelligence configuration is inconsistent."""


def load_json(name: str) -> dict[str, Any]:
    path = CONFIG / name

    try:
        with path.open("r", encoding="utf-8") as handle:
            document = json.load(handle)
    except FileNotFoundError as exc:
        raise ConfigurationError(f"Missing configuration: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigurationError(
            f"Invalid JSON in {path}: line {exc.lineno}, column {exc.colno}"
        ) from exc

    if not isinstance(document, dict):
        raise ConfigurationError(f"Expected JSON object in {path}")

    return document


def task_weighted_score(
    model_id: str,
    scorecard: dict[str, Any],
    criterion_weights: dict[str, int],
) -> float:
    models = scorecard.get("models", {})

    if model_id not in models:
        raise ConfigurationError(
            f"Model {model_id!r} is missing from scorecard"
        )

    scores = models[model_id]
    numerator = 0
    denominator = 0

    for criterion, weight in criterion_weights.items():
        if criterion not in scores:
            raise ConfigurationError(
                f"Model {model_id!r} has no score for {criterion!r}"
            )

        if not isinstance(weight, int) or weight <= 0:
            raise ConfigurationError(
                f"Invalid weight for {criterion!r}: {weight!r}"
            )

        numerator += scores[criterion] * weight
        denominator += weight

    if denominator == 0:
        raise ConfigurationError("Task criterion weights cannot be empty")

    return round(numerator / denominator, 2)


def find_rule(
    task: str,
    policy: dict[str, Any],
) -> dict[str, Any] | None:
    return next(
        (
            rule
            for rule in policy.get("rules", [])
            if rule.get("task") == task
        ),
        None,
    )


def recommend(
    task: str,
    *,
    include_evaluation: bool = False,
) -> dict[str, Any]:
    registry = load_json("model_registry.json")
    scorecard = load_json("scorecard.json")
    policy = load_json("routing_policy.json")

    models = {
        model["id"]: model
        for model in registry.get("models", [])
        if isinstance(model, dict) and "id" in model
    }

    rule = find_rule(task, policy)

    if rule is None:
        known_tasks = sorted(
            candidate.get("task", "")
            for candidate in policy.get("rules", [])
            if candidate.get("task")
        )
        raise ValueError(
            f"Unknown task {task!r}. Known tasks: {', '.join(known_tasks)}"
        )

    required_privacy = rule.get("required_privacy_tier")
    criterion_weights = rule.get("criterion_weights")

    if not isinstance(criterion_weights, dict) or not criterion_weights:
        raise ConfigurationError(
            f"Routing rule {task!r} has no criterion_weights"
        )

    allowed_statuses = set(
        rule.get(
            "allowed_statuses",
            ["production", "production-fallback"],
        )
    )

    if include_evaluation:
        allowed_statuses.update(
            policy.get("evaluation_statuses", ["evaluation", "watch"])
        )

    preferred = list(rule.get("preferred_models", []))
    fallback = list(rule.get("fallback_models", []))

    candidate_groups = [
        ("preferred", preferred),
        ("fallback", fallback),
    ]

    eligible: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []

    for group_name, candidate_ids in candidate_groups:
        for preference_index, model_id in enumerate(candidate_ids):
            model = models.get(model_id)

            if model is None:
                rejected.append(
                    {
                        "model": model_id,
                        "group": group_name,
                        "reason": "missing-from-registry",
                    }
                )
                continue

            status = model.get("status")

            if status not in allowed_statuses:
                rejected.append(
                    {
                        "model": model_id,
                        "group": group_name,
                        "reason": f"status-not-allowed:{status}",
                    }
                )
                continue

            privacy_tier = model.get("privacy_tier")

            if required_privacy and privacy_tier != required_privacy:
                rejected.append(
                    {
                        "model": model_id,
                        "group": group_name,
                        "reason": (
                            "privacy-tier-mismatch:"
                            f"required={required_privacy},actual={privacy_tier}"
                        ),
                    }
                )
                continue

            score = task_weighted_score(
                model_id,
                scorecard,
                criterion_weights,
            )

            eligible.append(
                {
                    "model_id": model_id,
                    "display_name": model.get("display_name", model_id),
                    "provider": model.get("provider"),
                    "deployment": model.get("deployment"),
                    "status": status,
                    "privacy_tier": privacy_tier,
                    "cost_tier": model.get("cost_tier"),
                    "candidate_group": group_name,
                    "preference_index": preference_index,
                    "task_weighted_score": score,
                }
            )

    if not eligible:
        raise RuntimeError(
            f"No eligible model found for task {task!r}"
        )

    group_priority = {
        "preferred": 0,
        "fallback": 1,
    }

    eligible.sort(
        key=lambda candidate: (
            group_priority[candidate["candidate_group"]],
            -candidate["task_weighted_score"],
            candidate["preference_index"],
            candidate["model_id"],
        )
    )

    best = eligible[0]

    return {
        "schema_version": 2,
        "mode": (
            "evaluation"
            if include_evaluation
            else policy.get("routing_mode", "production-safe")
        ),
        "task": task,
        "recommended_model": best["model_id"],
        "display_name": best["display_name"],
        "provider": best["provider"],
        "deployment": best["deployment"],
        "status": best["status"],
        "privacy_tier": best["privacy_tier"],
        "cost_tier": best["cost_tier"],
        "candidate_group": best["candidate_group"],
        "task_weighted_score": best["task_weighted_score"],
        "score_status": scorecard.get("score_status", "unknown"),
        "required_privacy_tier": required_privacy,
        "criterion_weights": criterion_weights,
        "eligible_candidates": eligible,
        "rejected_candidates": rejected,
        "production_model_changed": False,
        "warning": (
            "Scores remain provisional until supported by benchmark evidence."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Recommend an OpenClaw model for a task."
    )
    parser.add_argument("--task", required=True)
    parser.add_argument(
        "--include-evaluation",
        action="store_true",
        help="Allow evaluation/watch models to participate.",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Emit compact JSON.",
    )
    args = parser.parse_args()

    try:
        result = recommend(
            args.task,
            include_evaluation=args.include_evaluation,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except ConfigurationError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 3
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 4

    print(
        json.dumps(
            result,
            indent=None if args.compact else 2,
            sort_keys=args.compact,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
