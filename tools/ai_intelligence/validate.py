#!/usr/bin/env python3
"""Validate the complete AI Intelligence Layer configuration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config" / "ai_intelligence"

FILES = [
    "model_registry.json",
    "scorecard.json",
    "routing_policy.json",
    "benchmarks.json",
    "technology_watch.json",
    "deployment_map.json",
]

PRODUCTION_STATUSES = {
    "production",
    "production-fallback",
}

KNOWN_STATUSES = PRODUCTION_STATUSES | {
    "evaluation",
    "watch",
    "disabled",
}


def load(name: str) -> dict[str, Any]:
    path = CONFIG / name

    with path.open("r", encoding="utf-8") as handle:
        document = json.load(handle)

    if not isinstance(document, dict):
        raise AssertionError(f"{name} must contain a JSON object")

    return document


def main() -> int:
    documents = {
        name: load(name)
        for name in FILES
    }

    registry = documents["model_registry.json"]
    scorecard = documents["scorecard.json"]
    policy = documents["routing_policy.json"]

    registry_models = registry.get("models", [])
    registry_ids = [
        model["id"]
        for model in registry_models
    ]

    assert len(registry_ids) == len(set(registry_ids)), (
        "Duplicate IDs exist in model registry"
    )

    registry_by_id = {
        model["id"]: model
        for model in registry_models
    }

    score_models = scorecard.get("models", {})
    score_ids = set(score_models)

    assert set(registry_ids) == score_ids, (
        "Registry/scorecard mismatch: "
        f"{set(registry_ids) ^ score_ids}"
    )

    criteria = scorecard.get("criteria", {})

    assert criteria, "Scorecard criteria cannot be empty"

    for criterion, weight in criteria.items():
        assert isinstance(weight, int) and weight > 0, (
            f"Invalid global criterion weight: {criterion}={weight!r}"
        )

    minimum = scorecard.get("scale", {}).get("minimum", 1)
    maximum = scorecard.get("scale", {}).get("maximum", 10)

    for model_id, model in registry_by_id.items():
        status = model.get("status")
        assert status in KNOWN_STATUSES, (
            f"{model_id} has unknown status {status!r}"
        )

        for required_field in [
            "display_name",
            "provider",
            "deployment",
            "privacy_tier",
            "cost_tier",
        ]:
            assert model.get(required_field), (
                f"{model_id} is missing {required_field}"
            )

    for model_id, scores in score_models.items():
        assert set(scores) == set(criteria), (
            f"{model_id} score criteria mismatch: "
            f"{set(scores) ^ set(criteria)}"
        )

        for criterion, value in scores.items():
            assert isinstance(value, (int, float)), (
                f"{model_id}.{criterion} is not numeric"
            )
            assert minimum <= value <= maximum, (
                f"{model_id}.{criterion} outside "
                f"{minimum}-{maximum}"
            )

    rules = policy.get("rules", [])
    task_names = [
        rule.get("task")
        for rule in rules
    ]

    assert len(task_names) == len(set(task_names)), (
        "Duplicate routing task names"
    )

    for rule in rules:
        task = rule.get("task")
        assert task, "Routing rule missing task"

        preferred = rule.get("preferred_models", [])
        fallback = rule.get("fallback_models", [])

        assert preferred, (
            f"{task} must have at least one preferred model"
        )
        assert fallback, (
            f"{task} must have at least one fallback model"
        )

        assert not set(preferred) & set(fallback), (
            f"{task} repeats models across preferred/fallback"
        )

        for model_id in preferred + fallback:
            assert model_id in registry_by_id, (
                f"Unknown routing model: {model_id}"
            )

        allowed_statuses = set(
            rule.get("allowed_statuses", [])
        )

        assert allowed_statuses, (
            f"{task} has no allowed_statuses"
        )
        assert allowed_statuses <= KNOWN_STATUSES, (
            f"{task} contains unknown allowed statuses: "
            f"{allowed_statuses - KNOWN_STATUSES}"
        )

        task_weights = rule.get("criterion_weights", {})

        assert task_weights, (
            f"{task} has no criterion_weights"
        )
        assert set(task_weights) <= set(criteria), (
            f"{task} uses unknown criteria: "
            f"{set(task_weights) - set(criteria)}"
        )

        for criterion, weight in task_weights.items():
            assert isinstance(weight, int) and weight > 0, (
                f"{task}.{criterion} has invalid weight {weight!r}"
            )

        required_privacy = rule.get("required_privacy_tier")

        if required_privacy:
            eligible_local = [
                model_id
                for model_id in preferred + fallback
                if (
                    registry_by_id[model_id].get("privacy_tier")
                    == required_privacy
                    and registry_by_id[model_id].get("status")
                    in allowed_statuses
                )
            ]
            assert eligible_local, (
                f"{task} has no model satisfying privacy/status rules"
            )

        production_candidates = [
            model_id
            for model_id in preferred + fallback
            if registry_by_id[model_id].get("status")
            in PRODUCTION_STATUSES
        ]

        assert production_candidates, (
            f"{task} has no production-capable candidate"
        )

    benchmarks = documents["benchmarks.json"].get(
        "benchmarks",
        []
    )

    benchmark_ids = [
        benchmark.get("id")
        for benchmark in benchmarks
    ]

    assert all(benchmark_ids), "Benchmark missing ID"
    assert len(benchmark_ids) == len(set(benchmark_ids)), (
        "Duplicate benchmark IDs"
    )

    print("AI Intelligence Layer validation: PASS")
    print(f"Models: {len(registry_ids)}")
    print(f"Routing rules: {len(rules)}")
    print(f"Benchmarks: {len(benchmarks)}")
    print("Routing policy schema: "
          f"{policy.get('schema_version')}")
    print("Production-safe status enforcement: PASS")
    print("Task-specific criterion weights: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
