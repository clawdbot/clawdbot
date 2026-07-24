"""Typed data models for the OpenClaw Runtime AI Router.

These models contain validation and data representation only.
They do not query PostgreSQL, select models, or execute providers.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from tools.ai_intelligence.database import DeploymentAssignmentRecord


class RoutingModelError(ValueError):
    """Raised when routing model data is invalid."""


class PrivacyTier(str, Enum):
    """Privacy classifications stored by AI Intelligence."""

    LOCAL = "local"
    MIXED = "mixed"
    EXTERNAL_APPROVED = "external-approved"


class AssignmentType(str, Enum):
    """Role of a model within a component's routing chain."""

    PRIMARY = "primary"
    FALLBACK = "fallback"


class RoutingMode(str, Enum):
    """Runtime routing modes stored by AI Intelligence."""

    PRODUCTION_SAFE = "production-safe"


@dataclass(frozen=True)
class RoutingRequest:
    """Request for a routing decision."""

    component_id: str
    privacy_tier: PrivacyTier | None = None
    request_id: str | None = None

    def __post_init__(self) -> None:
        if not self.component_id.strip():
            raise RoutingModelError(
                "RoutingRequest.component_id cannot be empty"
            )

        if self.request_id is not None and not self.request_id.strip():
            raise RoutingModelError(
                "RoutingRequest.request_id cannot be blank"
            )


@dataclass(frozen=True)
class ModelAssignment:
    """One model candidate in an ordered routing chain."""

    component_id: str
    component_name: str
    component_privacy_tier: PrivacyTier
    task_type: str
    assignment_type: AssignmentType
    priority: int
    model_id: str
    model_name: str
    provider: str
    deployment: str
    model_status: str
    routing_mode: RoutingMode
    human_approved: bool
    configuration_source: str | None = None
    assignment_reason: str | None = None

    def __post_init__(self) -> None:
        required_fields = {
            "component_id": self.component_id,
            "component_name": self.component_name,
            "task_type": self.task_type,
            "model_id": self.model_id,
            "model_name": self.model_name,
            "provider": self.provider,
            "deployment": self.deployment,
            "model_status": self.model_status,
        }

        missing = [
            name
            for name, value in required_fields.items()
            if not value.strip()
        ]

        if missing:
            raise RoutingModelError(
                "ModelAssignment contains blank required fields: "
                + ", ".join(sorted(missing))
            )

        if self.priority < 1:
            raise RoutingModelError(
                "ModelAssignment.priority must be at least 1"
            )

    @property
    def is_local(self) -> bool:
        """Return True when the model deployment is local."""

        return self.deployment.lower() == "local"

    @property
    def is_primary(self) -> bool:
        """Return True when this assignment is the primary."""

        return self.assignment_type is AssignmentType.PRIMARY

    @classmethod
    def from_database_record(
        cls,
        record: DeploymentAssignmentRecord,
    ) -> "ModelAssignment":
        """Convert a database adapter record into a typed assignment."""

        try:
            privacy_tier = PrivacyTier(
                record.component_privacy_tier
            )
        except ValueError as exc:
            raise RoutingModelError(
                "Unsupported privacy tier: "
                f"{record.component_privacy_tier}"
            ) from exc

        try:
            assignment_type = AssignmentType(
                record.assignment_type
            )
        except ValueError as exc:
            raise RoutingModelError(
                "Unsupported assignment type: "
                f"{record.assignment_type}"
            ) from exc

        try:
            routing_mode = RoutingMode(record.routing_mode)
        except ValueError as exc:
            raise RoutingModelError(
                f"Unsupported routing mode: {record.routing_mode}"
            ) from exc

        return cls(
            component_id=record.component_id,
            component_name=record.component_name,
            component_privacy_tier=privacy_tier,
            task_type=record.task_type,
            assignment_type=assignment_type,
            priority=record.priority,
            model_id=record.model_id,
            model_name=record.model_name,
            provider=record.provider,
            deployment=record.deployment,
            model_status=record.model_status,
            routing_mode=routing_mode,
            configuration_source=record.configuration_source,
            assignment_reason=record.assignment_reason,
            human_approved=record.human_approved,
        )


@dataclass(frozen=True)
class FallbackChain:
    """Validated primary model and ordered fallback models."""

    primary: ModelAssignment
    fallbacks: tuple[ModelAssignment, ...]

    def __post_init__(self) -> None:
        if not self.primary.is_primary:
            raise RoutingModelError(
                "FallbackChain.primary must have assignment_type=primary"
            )

        for fallback in self.fallbacks:
            if fallback.assignment_type is not AssignmentType.FALLBACK:
                raise RoutingModelError(
                    "Every fallback must have "
                    "assignment_type=fallback"
                )

            if fallback.component_id != self.primary.component_id:
                raise RoutingModelError(
                    "All fallback assignments must belong to the "
                    "same component as the primary"
                )

        priorities = [
            fallback.priority
            for fallback in self.fallbacks
        ]

        if priorities != sorted(priorities):
            raise RoutingModelError(
                "Fallback assignments must be ordered by priority"
            )

        model_ids = [
            self.primary.model_id,
            *(fallback.model_id for fallback in self.fallbacks),
        ]

        if len(model_ids) != len(set(model_ids)):
            raise RoutingModelError(
                "FallbackChain cannot contain duplicate model IDs"
            )

    @property
    def ordered_candidates(self) -> tuple[ModelAssignment, ...]:
        """Return the primary followed by all ordered fallbacks."""

        return (self.primary, *self.fallbacks)

    @classmethod
    def from_assignments(
        cls,
        assignments: Sequence[ModelAssignment],
    ) -> "FallbackChain":
        """Build a validated chain from model assignments."""

        primary_assignments = [
            assignment
            for assignment in assignments
            if assignment.assignment_type is AssignmentType.PRIMARY
        ]

        fallback_assignments = sorted(
            (
                assignment
                for assignment in assignments
                if assignment.assignment_type
                is AssignmentType.FALLBACK
            ),
            key=lambda assignment: (
                assignment.priority,
                assignment.model_id,
            ),
        )

        if len(primary_assignments) != 1:
            raise RoutingModelError(
                "Exactly one primary assignment is required; "
                f"found {len(primary_assignments)}"
            )

        return cls(
            primary=primary_assignments[0],
            fallbacks=tuple(fallback_assignments),
        )


@dataclass(frozen=True)
class RoutingDecision:
    """Complete routing decision returned to a runtime caller."""

    request: RoutingRequest
    component_name: str
    task_type: str
    privacy_tier: PrivacyTier
    routing_mode: RoutingMode
    chain: FallbackChain

    def __post_init__(self) -> None:
        if self.request.component_id != self.chain.primary.component_id:
            raise RoutingModelError(
                "RoutingDecision request component does not match "
                "the assignment chain"
            )

        if self.privacy_tier != (
            self.chain.primary.component_privacy_tier
        ):
            raise RoutingModelError(
                "RoutingDecision privacy tier does not match "
                "the primary assignment"
            )

        if self.routing_mode != self.chain.primary.routing_mode:
            raise RoutingModelError(
                "RoutingDecision routing mode does not match "
                "the primary assignment"
            )

    @property
    def primary(self) -> ModelAssignment:
        """Return the selected primary assignment."""

        return self.chain.primary

    @property
    def fallbacks(self) -> tuple[ModelAssignment, ...]:
        """Return the ordered fallback assignments."""

        return self.chain.fallbacks

    @property
    def candidate_model_ids(self) -> tuple[str, ...]:
        """Return all candidate model IDs in execution order."""

        return tuple(
            assignment.model_id
            for assignment in self.chain.ordered_candidates
        )
