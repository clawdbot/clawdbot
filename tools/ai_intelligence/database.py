"""PostgreSQL adapter for the OpenClaw AI Intelligence runtime.

This module performs database access only. It does not select models,
enforce routing policy, or execute failover.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Sequence

import psycopg2
from psycopg2.extensions import connection as PgConnection
from psycopg2.extras import Json, RealDictCursor


class DatabaseConfigurationError(RuntimeError):
    """Raised when required database configuration is missing or invalid."""


class DatabaseQueryError(RuntimeError):
    """Raised when an AI Intelligence database query fails."""


@dataclass(frozen=True)
class DatabaseConfig:
    """Connection settings for the AI Intelligence PostgreSQL database."""

    host: str
    port: int
    dbname: str
    user: str
    password: str
    connect_timeout: int = 8

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "DatabaseConfig":
        env = os.environ if environ is None else environ

        required = {
            "OPENCLAW_DB_HOST": env.get("OPENCLAW_DB_HOST"),
            "OPENCLAW_DB_PORT": env.get("OPENCLAW_DB_PORT"),
            "OPENCLAW_DB_NAME": env.get("OPENCLAW_DB_NAME"),
            "OPENCLAW_DB_USER": env.get("OPENCLAW_DB_USER"),
            "OPENCLAW_DB_PASSWORD": env.get("OPENCLAW_DB_PASSWORD"),
        }

        missing = [
            name
            for name, value in required.items()
            if value is None or not str(value).strip()
        ]

        if missing:
            raise DatabaseConfigurationError(
                "Missing required database environment variables: "
                + ", ".join(sorted(missing))
            )

        try:
            port = int(str(required["OPENCLAW_DB_PORT"]))
        except ValueError as exc:
            raise DatabaseConfigurationError(
                "OPENCLAW_DB_PORT must be an integer"
            ) from exc

        return cls(
            host=str(required["OPENCLAW_DB_HOST"]),
            port=port,
            dbname=str(required["OPENCLAW_DB_NAME"]),
            user=str(required["OPENCLAW_DB_USER"]),
            password=str(required["OPENCLAW_DB_PASSWORD"]),
        )


@dataclass(frozen=True)
class ComponentRecord:
    """Registered OpenClaw component metadata."""

    component_id: str
    display_name: str
    description: str | None
    privacy_tier: str
    task_type: str
    active: bool
    metadata: Mapping[str, Any]


@dataclass(frozen=True)
class DeploymentAssignmentRecord:
    """One active model assignment from current_model_deployment."""

    component_id: str
    component_name: str
    component_privacy_tier: str
    task_type: str
    assignment_type: str
    priority: int
    model_id: str
    model_name: str
    provider: str
    deployment: str
    model_status: str
    routing_mode: str
    configuration_source: str | None
    assignment_reason: str | None
    human_approved: bool
    effective_from: Any


class AIIntelligenceDatabase:
    """Database adapter for AI Intelligence runtime reads and telemetry writes."""

    def __init__(
        self,
        config: DatabaseConfig,
        connect_factory: Any = psycopg2.connect,
    ) -> None:
        self._config = config
        self._connect_factory = connect_factory

    @contextmanager
    def connection(self) -> Iterator[PgConnection]:
        with self._connect(readonly=True) as connection:
            yield connection

    @contextmanager
    def writable_connection(self) -> Iterator[PgConnection]:
        with self._connect(readonly=False) as connection:
            yield connection

    @contextmanager
    def _connect(self, *, readonly: bool) -> Iterator[PgConnection]:
        connection: PgConnection | None = None

        try:
            connection = self._connect_factory(
                host=self._config.host,
                port=self._config.port,
                dbname=self._config.dbname,
                user=self._config.user,
                password=self._config.password,
                connect_timeout=self._config.connect_timeout,
                application_name="openclaw-ai-intelligence-router",
            )

            connection.set_session(
                readonly=readonly,
                autocommit=True,
            )

            yield connection

        except psycopg2.Error as exc:
            raise DatabaseQueryError(
                f"AI Intelligence database operation failed: {exc}"
            ) from exc

        finally:
            if connection is not None:
                connection.close()

    def get_component(
        self,
        component_id: str,
    ) -> ComponentRecord | None:
        """Return a registered component, or None when it does not exist."""

        query = """
            SELECT
                component_id,
                display_name,
                description,
                privacy_tier,
                task_type,
                active,
                component_metadata
            FROM ai_intelligence.project_components
            WHERE component_id = %s
        """

        with self.connection() as connection:
            with connection.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                cursor.execute(query, (component_id,))
                row = cursor.fetchone()

        if row is None:
            return None

        return ComponentRecord(
            component_id=row["component_id"],
            display_name=row["display_name"],
            description=row["description"],
            privacy_tier=row["privacy_tier"],
            task_type=row["task_type"],
            active=row["active"],
            metadata=row["component_metadata"] or {},
        )

    def get_active_assignments(
        self,
        component_id: str,
    ) -> Sequence[DeploymentAssignmentRecord]:
        """Return ordered active assignments for a component."""

        query = """
            SELECT
                component_id,
                component_name,
                component_privacy_tier,
                task_type,
                assignment_type,
                priority,
                model_id,
                model_name,
                provider,
                deployment,
                model_status,
                routing_mode,
                configuration_source,
                assignment_reason,
                human_approved,
                effective_from
            FROM ai_intelligence.current_model_deployment
            WHERE component_id = %s
            ORDER BY
                CASE assignment_type
                    WHEN 'primary' THEN 0
                    WHEN 'fallback' THEN 1
                    ELSE 2
                END,
                priority,
                model_id
        """

        with self.connection() as connection:
            with connection.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                cursor.execute(query, (component_id,))
                rows = cursor.fetchall()

        return tuple(
            DeploymentAssignmentRecord(
                component_id=row["component_id"],
                component_name=row["component_name"],
                component_privacy_tier=row[
                    "component_privacy_tier"
                ],
                task_type=row["task_type"],
                assignment_type=row["assignment_type"],
                priority=row["priority"],
                model_id=row["model_id"],
                model_name=row["model_name"],
                provider=row["provider"],
                deployment=row["deployment"],
                model_status=row["model_status"],
                routing_mode=row["routing_mode"],
                configuration_source=row["configuration_source"],
                assignment_reason=row["assignment_reason"],
                human_approved=row["human_approved"],
                effective_from=row["effective_from"],
            )
            for row in rows
        )

    def list_routable_component_ids(self) -> Sequence[str]:
        """Return component IDs with one or more active assignments."""

        query = """
            SELECT DISTINCT component_id
            FROM ai_intelligence.current_model_deployment
            ORDER BY component_id
        """

        with self.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query)
                rows = cursor.fetchall()

        return tuple(row[0] for row in rows)

    def record_observed_usage(
        self,
        *,
        component_id: str,
        model_id: str,
        request_id: str | None,
        task_type: str | None,
        routing_mode: str | None,
        selected_as: str | None,
        success: bool | None,
        duration_ms: int | None,
        privacy_tier: str | None,
        usage_metadata: Mapping[str, Any] | None = None,
    ) -> None:
        """Persist one observed routing/execution outcome."""

        query = """
            INSERT INTO ai_intelligence.observed_model_usage (
                component_id,
                model_id,
                request_id,
                task_type,
                routing_mode,
                selected_as,
                success,
                duration_ms,
                privacy_tier,
                usage_metadata
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
        """

        with self.writable_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    query,
                    (
                        component_id,
                        model_id,
                        request_id,
                        task_type,
                        routing_mode,
                        selected_as,
                        success,
                        duration_ms,
                        privacy_tier,
                        Json(dict(usage_metadata or {})),
                    ),
                )

    def list_deployment_drift(self) -> Sequence[Mapping[str, Any]]:
        """Return configured-primary versus latest-observed model drift."""

        query = """
            SELECT
                component_id,
                component_name,
                configured_primary_model,
                latest_observed_model,
                observed_at,
                deployment_status
            FROM ai_intelligence.deployment_drift
            ORDER BY component_id
        """

        with self.connection() as connection:
            with connection.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                cursor.execute(query)
                rows = cursor.fetchall()

        return tuple(dict(row) for row in rows)

    def list_recent_observed_usage(
        self,
        *,
        limit: int = 20,
    ) -> Sequence[Mapping[str, Any]]:
        """Return recent observed usage rows for operator summaries."""

        if limit < 1:
            raise DatabaseConfigurationError(
                "limit must be at least 1"
            )

        query = """
            SELECT
                component_id,
                model_id,
                request_id,
                selected_as,
                success,
                duration_ms,
                routing_mode,
                usage_metadata,
                observed_at
            FROM ai_intelligence.observed_model_usage
            ORDER BY observed_at DESC, observed_usage_id DESC
            LIMIT %s
        """

        with self.connection() as connection:
            with connection.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
                cursor.execute(query, (limit,))
                rows = cursor.fetchall()

        normalized: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            metadata = item.get("usage_metadata")
            if isinstance(metadata, str):
                item["usage_metadata"] = json.loads(metadata)
            elif metadata is None:
                item["usage_metadata"] = {}
            else:
                item["usage_metadata"] = dict(metadata)
            normalized.append(item)

        return tuple(normalized)
