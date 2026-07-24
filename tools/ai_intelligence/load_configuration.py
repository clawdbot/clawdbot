#!/usr/bin/env python3
"""Load OpenClaw AI Intelligence JSON configuration into PostgreSQL.

The repository JSON files remain the engineering source of truth.
PostgreSQL is the operational representation.

The loader is:
- transactional;
- idempotent;
- non-destructive;
- independent of a locally installed psql client;
- designed for the isolated Docker development database.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config" / "ai_intelligence"

MODEL_REGISTRY = CONFIG_DIR / "model_registry.json"
DEPLOYMENT_MAP = CONFIG_DIR / "deployment_map.json"
ROUTING_POLICY = CONFIG_DIR / "routing_policy.json"
SCORECARD = CONFIG_DIR / "scorecard.json"

DEFAULT_CONTAINER = "openclaw-ai-postgres-dev"
DEFAULT_DATABASE = "openclaw_ai_dev"
DEFAULT_USER = "openclaw_ai"
SCHEMA = "ai_intelligence"


class ConfigurationError(RuntimeError):
    """Raised when repository configuration violates the loader contract."""


@dataclass(frozen=True)
class LoadPlan:
    models: list[dict[str, Any]]
    benchmarks: list[dict[str, Any]]
    components: list[dict[str, Any]]
    assignments: list[dict[str, Any]]
    routing_mode: str
    source_files: list[str]


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ConfigurationError(f"Required configuration file is missing: {path}")

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"Invalid JSON in {path}: {exc}") from exc

    if not isinstance(data, dict):
        raise ConfigurationError(f"Expected a JSON object in {path}")

    return data


def sql_text(value: Any) -> str:
    if value is None:
        return "NULL"

    text = str(value).replace("'", "''")
    return f"'{text}'"


def sql_bool(value: Any) -> str:
    return "TRUE" if bool(value) else "FALSE"


def sql_int(value: Any, default: int) -> str:
    if value is None:
        return str(default)

    if isinstance(value, bool):
        raise ConfigurationError("Boolean value cannot be used as an integer")

    try:
        return str(int(value))
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"Expected integer-compatible value: {value!r}") from exc


def sql_numeric(value: Any, default: int | float | None = None) -> str:
    if value is None:
        return "NULL" if default is None else str(default)

    if isinstance(value, bool):
        raise ConfigurationError("Boolean value cannot be used as a numeric score")

    try:
        return str(float(value))
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"Expected numeric value: {value!r}") from exc


def sql_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).replace("'", "''")
    return f"'{encoded}'::jsonb"


def require_string(record: dict[str, Any], key: str, context: str) -> str:
    value = record.get(key)

    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{context} requires a non-empty '{key}'")

    return value.strip()


def find_benchmark_configuration() -> tuple[Path, dict[str, Any]]:
    candidates: list[tuple[Path, dict[str, Any]]] = []

    for path in sorted(CONFIG_DIR.glob("*.json")):
        data = read_json(path)
        benchmarks = data.get("benchmarks")

        if isinstance(benchmarks, list):
            candidates.append((path, data))

    if not candidates:
        raise ConfigurationError(
            "No config/ai_intelligence JSON file contains a top-level "
            "'benchmarks' array"
        )

    exact_names = {
        "benchmarks.json",
        "benchmark_registry.json",
        "benchmark_config.json",
        "benchmark_configuration.json",
    }

    preferred = [
        item for item in candidates
        if item[0].name in exact_names
    ]

    if len(preferred) == 1:
        return preferred[0]

    if len(candidates) == 1:
        return candidates[0]

    names = ", ".join(str(path.relative_to(ROOT)) for path, _ in candidates)
    raise ConfigurationError(
        "Multiple benchmark configuration files were found: "
        f"{names}"
    )


def normalize_benchmark(
    record: dict[str, Any],
    source_path: Path,
    schema_version: Any,
) -> dict[str, Any]:
    benchmark_id = (
        record.get("id")
        or record.get("benchmark_id")
        or record.get("key")
    )

    if not isinstance(benchmark_id, str) or not benchmark_id.strip():
        raise ConfigurationError(
            f"Benchmark in {source_path} requires id, benchmark_id, or key"
        )

    benchmark_id = benchmark_id.strip()

    display_name = (
        record.get("display_name")
        or record.get("name")
        or benchmark_id.replace("_", " ").replace("-", " ").title()
    )

    category = (
        record.get("category")
        or record.get("task_type")
        or record.get("domain")
        or "general"
    )

    maximum_score = record.get(
        "maximum_score",
        record.get("max_score", 100),
    )

    passing_score = record.get(
        "passing_score",
        record.get("pass_score"),
    )

    benchmark_version = (
        record.get("benchmark_version")
        or record.get("version")
        or "1"
    )

    active = record.get("active", True)

    return {
        "benchmark_id": benchmark_id,
        "display_name": str(display_name),
        "category": str(category),
        "description": record.get("description"),
        "maximum_score": maximum_score,
        "passing_score": passing_score,
        "benchmark_version": str(benchmark_version),
        "active": bool(active),
        "metadata": {
            "configuration_source": str(source_path.relative_to(ROOT)),
            "configuration_schema_version": schema_version,
            "source_record": record,
            "loader_managed": True,
        },
    }


def build_plan() -> LoadPlan:
    registry = read_json(MODEL_REGISTRY)
    deployment = read_json(DEPLOYMENT_MAP)
    routing = read_json(ROUTING_POLICY)
    scorecard = read_json(SCORECARD)
    benchmark_path, benchmark_config = find_benchmark_configuration()

    registry_models = registry.get("models")
    deployment_components = deployment.get("components")
    benchmark_records = benchmark_config.get("benchmarks")
    scorecard_models = scorecard.get("models", {})

    if not isinstance(registry_models, list):
        raise ConfigurationError("model_registry.json requires a models array")

    if not isinstance(deployment_components, list):
        raise ConfigurationError("deployment_map.json requires a components array")

    if not isinstance(benchmark_records, list):
        raise ConfigurationError("Benchmark configuration requires a benchmarks array")

    if not isinstance(scorecard_models, dict):
        raise ConfigurationError("scorecard.json models must be an object")

    routing_mode = routing.get("routing_mode", "production-safe")

    if not isinstance(routing_mode, str) or not routing_mode:
        raise ConfigurationError("routing_policy.json routing_mode must be a string")

    models: list[dict[str, Any]] = []
    model_ids: set[str] = set()

    for record in registry_models:
        if not isinstance(record, dict):
            raise ConfigurationError("Every registry model must be an object")

        model_id = require_string(record, "id", "Registry model")

        if model_id in model_ids:
            raise ConfigurationError(f"Duplicate registry model: {model_id}")

        model_ids.add(model_id)

        models.append(
            {
                "model_id": model_id,
                "display_name": require_string(
                    record,
                    "display_name",
                    f"Model {model_id}",
                ),
                "provider": require_string(
                    record,
                    "provider",
                    f"Model {model_id}",
                ),
                "deployment": require_string(
                    record,
                    "deployment",
                    f"Model {model_id}",
                ),
                "status": require_string(
                    record,
                    "status",
                    f"Model {model_id}",
                ),
                "privacy_tier": require_string(
                    record,
                    "privacy_tier",
                    f"Model {model_id}",
                ),
                "cost_tier": require_string(
                    record,
                    "cost_tier",
                    f"Model {model_id}",
                ),
                "notes": record.get("notes"),
                "metadata": {
                    "configuration_source": str(
                        MODEL_REGISTRY.relative_to(ROOT)
                    ),
                    "configuration_schema_version": registry.get(
                        "schema_version"
                    ),
                    "configuration_updated": registry.get("updated"),
                    "score_status": scorecard.get("score_status"),
                    "scorecard": scorecard_models.get(model_id, {}),
                    "loader_managed": True,
                },
            }
        )

    benchmarks = [
        normalize_benchmark(
            record,
            benchmark_path,
            benchmark_config.get("schema_version"),
        )
        for record in benchmark_records
        if isinstance(record, dict)
    ]

    if len(benchmarks) != len(benchmark_records):
        raise ConfigurationError("Every benchmark must be a JSON object")

    benchmark_ids = [item["benchmark_id"] for item in benchmarks]

    if len(set(benchmark_ids)) != len(benchmark_ids):
        raise ConfigurationError("Duplicate benchmark IDs detected")

    components: list[dict[str, Any]] = []
    assignments: list[dict[str, Any]] = []
    component_ids: set[str] = set()

    allowed_statuses = deployment.get("assignment_statuses", [])

    if not isinstance(allowed_statuses, list):
        raise ConfigurationError(
            "deployment_map.json assignment_statuses must be an array"
        )

    for record in deployment_components:
        if not isinstance(record, dict):
            raise ConfigurationError("Every deployment component must be an object")

        component_id = require_string(record, "id", "Deployment component")

        if component_id in component_ids:
            raise ConfigurationError(
                f"Duplicate deployment component: {component_id}"
            )

        component_ids.add(component_id)

        assignment_status = require_string(
            record,
            "assignment_status",
            f"Component {component_id}",
        )

        if allowed_statuses and assignment_status not in allowed_statuses:
            raise ConfigurationError(
                f"Component {component_id} has unsupported assignment status "
                f"{assignment_status!r}"
            )

        component_metadata = {
            "configuration_source": str(DEPLOYMENT_MAP.relative_to(ROOT)),
            "configuration_schema_version": deployment.get("schema_version"),
            "configuration_updated": deployment.get("updated"),
            "verification_status": record.get("verification_status"),
            "loader_managed": True,
        }

        components.append(
            {
                "component_id": component_id,
                "display_name": require_string(
                    record,
                    "display_name",
                    f"Component {component_id}",
                ),
                "description": record.get("description"),
                "privacy_tier": require_string(
                    record,
                    "privacy_tier",
                    f"Component {component_id}",
                ),
                "task_type": record.get("task_type"),
                "active": bool(record.get("active", True)),
                "metadata": component_metadata,
            }
        )

        configuration_source = record.get(
            "configuration_source",
            str(DEPLOYMENT_MAP.relative_to(ROOT)),
        )

        primary_model = record.get("primary_model")

        if primary_model not in (None, "", "none"):
            if primary_model not in model_ids:
                raise ConfigurationError(
                    f"Component {component_id} references unknown primary model "
                    f"{primary_model!r}"
                )

            assignments.append(
                {
                    "component_id": component_id,
                    "assignment_type": "primary",
                    "model_id": primary_model,
                    "priority": 1,
                    "assignment_status": assignment_status,
                    "routing_mode": routing_mode,
                    "configuration_source": configuration_source,
                    "assignment_reason": (
                        "Primary model from deployment map configuration"
                    ),
                    "metadata": {
                        "verification_status": record.get(
                            "verification_status"
                        ),
                        "loader_managed": True,
                    },
                }
            )

        fallback_models = record.get("fallback_models", [])

        if fallback_models is None:
            fallback_models = []

        if not isinstance(fallback_models, list):
            raise ConfigurationError(
                f"Component {component_id} fallback_models must be an array"
            )

        for priority, model_id in enumerate(fallback_models, start=1):
            if model_id in (None, "", "none"):
                continue

            if model_id not in model_ids:
                raise ConfigurationError(
                    f"Component {component_id} references unknown fallback model "
                    f"{model_id!r}"
                )

            assignments.append(
                {
                    "component_id": component_id,
                    "assignment_type": "fallback",
                    "model_id": model_id,
                    "priority": priority,
                    "assignment_status": assignment_status,
                    "routing_mode": routing_mode,
                    "configuration_source": configuration_source,
                    "assignment_reason": (
                        "Fallback model from deployment map configuration"
                    ),
                    "metadata": {
                        "verification_status": record.get(
                            "verification_status"
                        ),
                        "loader_managed": True,
                    },
                }
            )

    return LoadPlan(
        models=models,
        benchmarks=benchmarks,
        components=components,
        assignments=assignments,
        routing_mode=routing_mode,
        source_files=[
            str(MODEL_REGISTRY.relative_to(ROOT)),
            str(SCORECARD.relative_to(ROOT)),
            str(DEPLOYMENT_MAP.relative_to(ROOT)),
            str(ROUTING_POLICY.relative_to(ROOT)),
            str(benchmark_path.relative_to(ROOT)),
        ],
    )


def model_sql(record: dict[str, Any]) -> str:
    return f"""
INSERT INTO {SCHEMA}.models (
    model_id,
    display_name,
    provider,
    deployment,
    status,
    privacy_tier,
    cost_tier,
    notes,
    registry_metadata
)
VALUES (
    {sql_text(record['model_id'])},
    {sql_text(record['display_name'])},
    {sql_text(record['provider'])},
    {sql_text(record['deployment'])},
    {sql_text(record['status'])},
    {sql_text(record['privacy_tier'])},
    {sql_text(record['cost_tier'])},
    {sql_text(record['notes'])},
    {sql_json(record['metadata'])}
)
ON CONFLICT (model_id)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    provider = EXCLUDED.provider,
    deployment = EXCLUDED.deployment,
    status = EXCLUDED.status,
    privacy_tier = EXCLUDED.privacy_tier,
    cost_tier = EXCLUDED.cost_tier,
    notes = EXCLUDED.notes,
    registry_metadata = EXCLUDED.registry_metadata,
    updated_at = now();
"""


def benchmark_sql(record: dict[str, Any]) -> str:
    return f"""
INSERT INTO {SCHEMA}.benchmarks (
    benchmark_id,
    display_name,
    category,
    description,
    maximum_score,
    passing_score,
    benchmark_version,
    active,
    benchmark_metadata
)
VALUES (
    {sql_text(record['benchmark_id'])},
    {sql_text(record['display_name'])},
    {sql_text(record['category'])},
    {sql_text(record['description'])},
    {sql_numeric(record['maximum_score'], 100)},
    {sql_numeric(record['passing_score'])},
    {sql_text(record['benchmark_version'])},
    {sql_bool(record['active'])},
    {sql_json(record['metadata'])}
)
ON CONFLICT (benchmark_id)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    maximum_score = EXCLUDED.maximum_score,
    passing_score = EXCLUDED.passing_score,
    benchmark_version = EXCLUDED.benchmark_version,
    active = EXCLUDED.active,
    benchmark_metadata = EXCLUDED.benchmark_metadata,
    updated_at = now();
"""


def component_sql(record: dict[str, Any]) -> str:
    return f"""
INSERT INTO {SCHEMA}.project_components (
    component_id,
    display_name,
    description,
    privacy_tier,
    task_type,
    active,
    component_metadata
)
VALUES (
    {sql_text(record['component_id'])},
    {sql_text(record['display_name'])},
    {sql_text(record['description'])},
    {sql_text(record['privacy_tier'])},
    {sql_text(record['task_type'])},
    {sql_bool(record['active'])},
    {sql_json(record['metadata'])}
)
ON CONFLICT (component_id)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    privacy_tier = EXCLUDED.privacy_tier,
    task_type = EXCLUDED.task_type,
    active = EXCLUDED.active,
    component_metadata = EXCLUDED.component_metadata,
    updated_at = now();
"""


def assignment_sql(record: dict[str, Any]) -> str:
    component_id = sql_text(record["component_id"])
    assignment_type = sql_text(record["assignment_type"])
    priority = sql_int(record["priority"], 1)

    return f"""
UPDATE {SCHEMA}.model_assignments
SET
    model_id = {sql_text(record['model_id'])},
    assignment_status = {sql_text(record['assignment_status'])},
    routing_mode = {sql_text(record['routing_mode'])},
    configuration_source = {sql_text(record['configuration_source'])},
    assignment_reason = {sql_text(record['assignment_reason'])},
    assignment_metadata = {sql_json(record['metadata'])},
    updated_at = now()
WHERE component_id = {component_id}
  AND assignment_type = {assignment_type}
  AND priority = {priority}
  AND effective_until IS NULL
  AND assignment_metadata ->> 'loader_managed' = 'true';

INSERT INTO {SCHEMA}.model_assignments (
    component_id,
    assignment_type,
    model_id,
    priority,
    assignment_status,
    routing_mode,
    configuration_source,
    assignment_reason,
    human_approved,
    assignment_metadata
)
SELECT
    {component_id},
    {assignment_type},
    {sql_text(record['model_id'])},
    {priority},
    {sql_text(record['assignment_status'])},
    {sql_text(record['routing_mode'])},
    {sql_text(record['configuration_source'])},
    {sql_text(record['assignment_reason'])},
    FALSE,
    {sql_json(record['metadata'])}
WHERE NOT EXISTS (
    SELECT 1
    FROM {SCHEMA}.model_assignments
    WHERE component_id = {component_id}
      AND assignment_type = {assignment_type}
      AND priority = {priority}
      AND effective_until IS NULL
      AND assignment_metadata ->> 'loader_managed' = 'true'
);
"""


def desired_assignment_keys(plan: LoadPlan) -> list[str]:
    return [
        "|".join(
            [
                item["component_id"],
                item["assignment_type"],
                str(item["priority"]),
            ]
        )
        for item in plan.assignments
    ]


def build_sql(plan: LoadPlan) -> str:
    statements: list[str] = [
        r"\set ON_ERROR_STOP on",
        "BEGIN;",
        f"SET LOCAL search_path TO {SCHEMA}, public;",
    ]

    statements.extend(model_sql(item) for item in plan.models)
    statements.extend(benchmark_sql(item) for item in plan.benchmarks)
    statements.extend(component_sql(item) for item in plan.components)

    desired_keys = desired_assignment_keys(plan)

    statements.append(
        f"""
UPDATE {SCHEMA}.model_assignments
SET
    effective_until = now(),
    assignment_status = 'superseded',
    updated_at = now()
WHERE effective_until IS NULL
  AND assignment_metadata ->> 'loader_managed' = 'true'
  AND (
      component_id || '|' || assignment_type || '|' || priority::text
  ) <> ALL ({sql_json(desired_keys)}::jsonb #>> '{{}}');
"""
        if False
        else ""
    )

    statements.extend(assignment_sql(item) for item in plan.assignments)

    statements.extend(
        [
            "COMMIT;",
            "",
            r"\echo '===== DATABASE LOAD COUNTS ====='",
            f"""
SELECT 'models' AS entity, COUNT(*) AS row_count
FROM {SCHEMA}.models
WHERE registry_metadata ->> 'loader_managed' = 'true'
UNION ALL
SELECT 'benchmarks', COUNT(*)
FROM {SCHEMA}.benchmarks
WHERE benchmark_metadata ->> 'loader_managed' = 'true'
UNION ALL
SELECT 'components', COUNT(*)
FROM {SCHEMA}.project_components
WHERE component_metadata ->> 'loader_managed' = 'true'
UNION ALL
SELECT 'active_assignments', COUNT(*)
FROM {SCHEMA}.model_assignments
WHERE assignment_metadata ->> 'loader_managed' = 'true'
  AND effective_until IS NULL
ORDER BY entity;
""",
        ]
    )

    return "\n".join(item for item in statements if item)


def run_psql(
    sql: str,
    container: str,
    database: str,
    database_user: str,
) -> None:
    command = [
        "docker",
        "exec",
        "-i",
        container,
        "psql",
        "--username",
        database_user,
        "--dbname",
        database,
        "--set",
        "ON_ERROR_STOP=1",
    ]

    result = subprocess.run(
        command,
        input=sql,
        text=True,
        cwd=ROOT,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(
            f"Database loader failed with exit status {result.returncode}"
        )


def print_plan(plan: LoadPlan) -> None:
    primary_count = sum(
        1 for item in plan.assignments
        if item["assignment_type"] == "primary"
    )
    fallback_count = sum(
        1 for item in plan.assignments
        if item["assignment_type"] == "fallback"
    )

    print("===== AI INTELLIGENCE LOAD PLAN =====")
    print(f"Models: {len(plan.models)}")
    print("Model versions: 0")
    print(
        "Model-version note: no authoritative version identifiers exist "
        "in the current registry; runtime discovery will populate them later."
    )
    print(f"Benchmarks: {len(plan.benchmarks)}")
    print(f"Components: {len(plan.components)}")
    print(f"Primary assignments: {primary_count}")
    print(f"Fallback assignments: {fallback_count}")
    print(f"Total assignments: {len(plan.assignments)}")
    print(f"Routing mode: {plan.routing_mode}")
    print("Sources:")

    for source in plan.source_files:
        print(f"  - {source}")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Load AI Intelligence configuration into PostgreSQL"
    )
    parser.add_argument(
        "--container",
        default=DEFAULT_CONTAINER,
    )
    parser.add_argument(
        "--database",
        default=DEFAULT_DATABASE,
    )
    parser.add_argument(
        "--database-user",
        default=DEFAULT_USER,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration and print the plan without changing PostgreSQL",
    )
    parser.add_argument(
        "--emit-sql",
        action="store_true",
        help="Print generated SQL without executing it",
    )

    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        plan = build_plan()
        print_plan(plan)

        sql = build_sql(plan)

        if args.emit_sql:
            print()
            print(sql)
            return 0

        if args.dry_run:
            print()
            print("Dry run: PASS")
            print("Database changed: no")
            return 0

        print()
        print("===== LOAD CONFIGURATION INTO POSTGRESQL =====")

        run_psql(
            sql=sql,
            container=args.container,
            database=args.database,
            database_user=args.database_user,
        )

        print()
        print("Configuration load: PASS")
        return 0

    except (ConfigurationError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
