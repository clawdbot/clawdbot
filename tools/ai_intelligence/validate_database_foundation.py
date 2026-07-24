#!/usr/bin/env python3
"""Validate the Phase 2A database and deployment-map contracts."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

REGISTRY_PATH = (
    ROOT
    / "config"
    / "ai_intelligence"
    / "model_registry.json"
)

DEPLOYMENT_PATH = (
    ROOT
    / "config"
    / "ai_intelligence"
    / "deployment_map.json"
)

MIGRATION_PATH = (
    ROOT
    / "migrations"
    / "ai_intelligence"
    / "001_benchmark_evidence_and_deployment_map.sql"
)

REQUIRED_TABLES = {
    "schema_migrations",
    "models",
    "model_versions",
    "benchmarks",
    "benchmark_runs",
    "benchmark_results",
    "project_components",
    "model_assignments",
    "assignment_history",
    "observed_model_usage",
    "promotion_history",
}

REQUIRED_VIEWS = {
    "current_model_deployment",
    "latest_observed_model_usage",
    "deployment_drift",
}


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        document = json.load(handle)

    assert isinstance(document, dict), (
        f"{path} must contain a JSON object"
    )

    return document


def main() -> int:
    registry = load_json(REGISTRY_PATH)
    deployment = load_json(DEPLOYMENT_PATH)
    sql = MIGRATION_PATH.read_text(encoding="utf-8")

    registry_ids = {
        model["id"]
        for model in registry["models"]
    }

    components = deployment.get("components", [])
    component_ids = [
        component["id"]
        for component in components
    ]

    assert components, "Deployment map has no components"
    assert len(component_ids) == len(set(component_ids)), (
        "Duplicate component IDs"
    )

    for component in components:
        component_id = component["id"]

        assert component.get("display_name"), (
            f"{component_id} missing display_name"
        )
        assert component.get("description"), (
            f"{component_id} missing description"
        )
        assert component.get("privacy_tier"), (
            f"{component_id} missing privacy_tier"
        )
        assert component.get("assignment_status"), (
            f"{component_id} missing assignment_status"
        )
        assert component.get("configuration_source"), (
            f"{component_id} missing configuration_source"
        )
        assert component.get("verification_status"), (
            f"{component_id} missing verification_status"
        )

        primary = component.get("primary_model")
        fallbacks = component.get("fallback_models", [])

        assert isinstance(fallbacks, list), (
            f"{component_id}.fallback_models must be a list"
        )

        if primary is None:
            assert component.get(
                "verification_status"
            ) == "not-model-serving", (
                f"{component_id} has no primary model but is "
                "not marked not-model-serving"
            )
            continue

        allowed_exception = component.get(
            "registry_exception",
            False,
        )

        assert primary in registry_ids or allowed_exception, (
            f"{component_id} uses unknown primary model {primary}"
        )

        assert primary not in fallbacks, (
            f"{component_id} repeats its primary as fallback"
        )

        for fallback in fallbacks:
            assert fallback in registry_ids or allowed_exception, (
                f"{component_id} uses unknown fallback {fallback}"
            )

        if component["privacy_tier"] == "local":
            external_models = {
                model["id"]
                for model in registry["models"]
                if model.get("privacy_tier") == "external"
            }

            assert primary not in external_models, (
                f"{component_id} local component has external primary"
            )
            assert not set(fallbacks) & external_models, (
                f"{component_id} local component has external fallback"
            )

    table_matches = set(
        re.findall(
            r"CREATE TABLE IF NOT EXISTS "
            r"ai_intelligence\.([a-z_]+)",
            sql,
            flags=re.IGNORECASE,
        )
    )

    view_matches = set(
        re.findall(
            r"CREATE OR REPLACE VIEW "
            r"ai_intelligence\.([a-z_]+)",
            sql,
            flags=re.IGNORECASE,
        )
    )

    missing_tables = REQUIRED_TABLES - table_matches
    missing_views = REQUIRED_VIEWS - view_matches

    assert not missing_tables, (
        f"Migration missing tables: {sorted(missing_tables)}"
    )
    assert not missing_views, (
        f"Migration missing views: {sorted(missing_views)}"
    )

    assert sql.strip().startswith("BEGIN;"), (
        "Migration must begin with BEGIN"
    )
    assert sql.strip().endswith("COMMIT;"), (
        "Migration must end with COMMIT"
    )

    assert "deployment_drift" in sql, (
        "Migration must provide deployment drift detection"
    )

    print("AI Intelligence database foundation: PASS")
    print(f"Deployment components: {len(components)}")
    print(f"Required tables: {len(REQUIRED_TABLES)}")
    print(f"Required views: {len(REQUIRED_VIEWS)}")
    print("Local privacy assignment validation: PASS")
    print("Configured/observed drift support: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
