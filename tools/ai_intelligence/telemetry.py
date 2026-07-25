"""Usage and failover telemetry for the AI execution engine.

Phase 2F.5 records configured versus observed routing without blocking
successful execution responses when telemetry persistence fails.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

from tools.ai_intelligence.execution_models import (
    AttemptStatus,
    ExecutionAttempt,
    ExecutionResult,
    ExecutionStatus,
)
from tools.ai_intelligence.routing_models import (
    AssignmentType,
    RoutingDecision,
)


@runtime_checkable
class ExecutionTelemetryRecorder(Protocol):
    """Persistence behavior required by the execution engine."""

    def record(
        self,
        decision: RoutingDecision,
        result: ExecutionResult,
    ) -> None:
        ...


@dataclass(frozen=True)
class ObservedUsageRecord:
    """One observed routing outcome ready for database persistence."""

    component_id: str
    model_id: str
    request_id: str
    task_type: str
    routing_mode: str
    selected_as: str
    success: bool
    duration_ms: int
    privacy_tier: str
    usage_metadata: Mapping[str, Any]


def build_observed_usage_record(
    decision: RoutingDecision,
    result: ExecutionResult,
) -> ObservedUsageRecord:
    """Build the observed-usage row for one execution result."""

    configured_primary = decision.chain.primary.model_id
    configured_candidates = tuple(
        assignment.model_id
        for assignment in decision.chain.ordered_candidates
    )
    assignment_by_model = {
        assignment.model_id: assignment
        for assignment in decision.chain.ordered_candidates
    }
    failover_occurred = (
        result.status is ExecutionStatus.SUCCESS
        and result.selected_model_id is not None
        and result.selected_model_id != configured_primary
    ) or (
        result.status is ExecutionStatus.FAILED
        and len(result.attempts) > 1
    )

    if result.selected_model_id is not None:
        observed_model_id = result.selected_model_id
    else:
        observed_model_id = result.attempts[-1].model_id

    selected_as = _selected_as(
        observed_model_id=observed_model_id,
        configured_primary=configured_primary,
        succeeded=result.status is ExecutionStatus.SUCCESS,
        assignment_type=(
            assignment_by_model[observed_model_id].assignment_type
            if observed_model_id in assignment_by_model
            else None
        ),
    )

    attempts = tuple(
        _serialize_attempt(
            attempt=attempt,
            attempt_number=index,
            assignment_type=(
                assignment_by_model[attempt.model_id].assignment_type
                if attempt.model_id in assignment_by_model
                else None
            ),
        )
        for index, attempt in enumerate(result.attempts, start=1)
    )

    duration_ms = sum(attempt.duration_ms for attempt in result.attempts)

    return ObservedUsageRecord(
        component_id=result.component_id,
        model_id=observed_model_id,
        request_id=result.request_id,
        task_type=decision.task_type,
        routing_mode=decision.routing_mode.value,
        selected_as=selected_as,
        success=result.status is ExecutionStatus.SUCCESS,
        duration_ms=duration_ms,
        privacy_tier=decision.privacy_tier.value,
        usage_metadata={
            "configured_primary_model_id": configured_primary,
            "configured_candidate_model_ids": list(
                configured_candidates
            ),
            "observed_selected_model_id": result.selected_model_id,
            "failover_occurred": failover_occurred,
            "attempt_count": len(attempts),
            "attempts": list(attempts),
            "final_status": result.status.value,
        },
    )


def summarize_failover_status(
    *,
    drift_rows: Sequence[Mapping[str, Any]],
    recent_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Build a briefing/dashboard summary from stored telemetry."""

    matched = 0
    drift = 0
    not_observed = 0
    for row in drift_rows:
        status = str(row.get("deployment_status", ""))
        if status == "matched":
            matched += 1
        elif status == "drift":
            drift += 1
        else:
            not_observed += 1

    recent_failovers = [
        row
        for row in recent_rows
        if bool((row.get("usage_metadata") or {}).get("failover_occurred"))
    ]
    recent_failures = [
        row for row in recent_rows if row.get("success") is False
    ]

    if drift > 0 or recent_failures:
        overall = "attention"
    elif recent_failovers:
        overall = "failover-active"
    elif matched > 0:
        overall = "healthy"
    else:
        overall = "unknown"

    return {
        "status": overall,
        "configured_versus_observed": {
            "matched": matched,
            "drift": drift,
            "not_observed": not_observed,
            "rows": [
                {
                    "component_id": row.get("component_id"),
                    "configured_primary_model": row.get(
                        "configured_primary_model"
                    ),
                    "latest_observed_model": row.get(
                        "latest_observed_model"
                    ),
                    "deployment_status": row.get("deployment_status"),
                    "observed_at": _stringify(row.get("observed_at")),
                }
                for row in drift_rows
            ],
        },
        "recent_failover_count": len(recent_failovers),
        "recent_failure_count": len(recent_failures),
        "recent_observations": [
            {
                "component_id": row.get("component_id"),
                "model_id": row.get("model_id"),
                "selected_as": row.get("selected_as"),
                "success": row.get("success"),
                "failover_occurred": bool(
                    (row.get("usage_metadata") or {}).get(
                        "failover_occurred"
                    )
                ),
                "observed_at": _stringify(row.get("observed_at")),
                "request_id": row.get("request_id"),
            }
            for row in recent_rows[:10]
        ],
    }


def format_failover_status_text(summary: Mapping[str, Any]) -> str:
    """Render a compact operator-facing telemetry summary."""

    configured = summary.get("configured_versus_observed", {})
    lines = [
        "AI Routing Telemetry",
        f"Status: {summary.get('status', 'unknown')}",
        (
            "Configured vs observed: "
            f"matched={configured.get('matched', 0)} "
            f"drift={configured.get('drift', 0)} "
            f"not_observed={configured.get('not_observed', 0)}"
        ),
        (
            "Recent failovers: "
            f"{summary.get('recent_failover_count', 0)}"
        ),
        (
            "Recent failures: "
            f"{summary.get('recent_failure_count', 0)}"
        ),
    ]

    drift_rows = [
        row
        for row in configured.get("rows", [])
        if row.get("deployment_status") == "drift"
    ]
    if drift_rows:
        lines.append("Drift:")
        for row in drift_rows[:5]:
            lines.append(
                "- "
                f"{row.get('component_id')}: "
                f"configured={row.get('configured_primary_model')} "
                f"observed={row.get('latest_observed_model')}"
            )

    failovers = [
        row
        for row in summary.get("recent_observations", [])
        if row.get("failover_occurred")
    ]
    if failovers:
        lines.append("Recent failover events:")
        for row in failovers[:5]:
            lines.append(
                "- "
                f"{row.get('component_id')} -> {row.get('model_id')} "
                f"at {row.get('observed_at')}"
            )

    return "\n".join(lines) + "\n"


def _selected_as(
    *,
    observed_model_id: str,
    configured_primary: str,
    succeeded: bool,
    assignment_type: AssignmentType | None,
) -> str:
    if not succeeded:
        return "unknown"

    if assignment_type is AssignmentType.PRIMARY:
        return "primary"

    if assignment_type is AssignmentType.FALLBACK:
        return "fallback"

    if observed_model_id == configured_primary:
        return "primary"

    return "fallback"


def _serialize_attempt(
    *,
    attempt: ExecutionAttempt,
    attempt_number: int,
    assignment_type: AssignmentType | None,
) -> dict[str, Any]:
    return {
        "attempt_number": attempt_number,
        "model_id": attempt.model_id,
        "provider_name": attempt.provider_name,
        "assignment_type": (
            assignment_type.value if assignment_type is not None else None
        ),
        "status": attempt.status.value,
        "duration_ms": attempt.duration_ms,
        "error_type": attempt.error_type,
        "error_message": attempt.error_message,
        "succeeded": attempt.status is AttemptStatus.SUCCESS,
    }


def _stringify(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def warn_telemetry_failure(error: Exception) -> None:
    """Emit a non-fatal telemetry warning for operators."""

    print(
        f"AI Intelligence telemetry recording failed: {error}",
        file=sys.stderr,
    )


def dumps_metadata(metadata: Mapping[str, Any]) -> str:
    """Serialize usage metadata for PostgreSQL jsonb storage."""

    return json.dumps(metadata, separators=(",", ":"), sort_keys=True)
