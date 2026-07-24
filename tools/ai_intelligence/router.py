"""Runtime decision engine for OpenClaw AI model routing.

The router reads active assignments through the database adapter and returns
a validated RoutingDecision. It does not invoke model providers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

from tools.ai_intelligence.database import (
    AIIntelligenceDatabase,
    ComponentRecord,
    DeploymentAssignmentRecord,
)
from tools.ai_intelligence.routing_models import (
    FallbackChain,
    ModelAssignment,
    PrivacyTier,
    RoutingDecision,
    RoutingModelError,
    RoutingRequest,
)


class RouterError(RuntimeError):
    """Base exception for runtime routing failures."""


class ComponentNotFoundError(RouterError):
    """Raised when the requested component is not registered."""


class ComponentInactiveError(RouterError):
    """Raised when a registered component is inactive."""


class ComponentNotRoutableError(RouterError):
    """Raised when a component intentionally has no model assignments."""


class RoutingConfigurationError(RouterError):
    """Raised when stored assignments cannot form a safe routing decision."""


class PrivacyMismatchError(RouterError):
    """Raised when a request attempts to weaken component privacy."""


class RoutingDatabase(Protocol):
    """Database operations required by the runtime router."""

    def get_component(
        self,
        component_id: str,
    ) -> ComponentRecord | None:
        ...

    def get_active_assignments(
        self,
        component_id: str,
    ) -> Sequence[DeploymentAssignmentRecord]:
        ...


@dataclass(frozen=True)
class AIRouter:
    """Build validated runtime routing decisions."""

    database: RoutingDatabase

    def route(self, request: RoutingRequest) -> RoutingDecision:
        """Return the active routing decision for a component."""

        component = self.database.get_component(request.component_id)

        if component is None:
            raise ComponentNotFoundError(
                f"Unknown AI Intelligence component: "
                f"{request.component_id}"
            )

        if not component.active:
            raise ComponentInactiveError(
                f"Component is inactive: {request.component_id}"
            )

        records = self.database.get_active_assignments(
            request.component_id
        )

        if not records:
            verification_status = component.metadata.get(
                "verification_status"
            )

            if verification_status == "not-model-serving":
                raise ComponentNotRoutableError(
                    f"Component is registered but not model-serving: "
                    f"{request.component_id}"
                )

            raise RoutingConfigurationError(
                f"Active component has no model assignments: "
                f"{request.component_id}"
            )

        try:
            assignments = tuple(
                ModelAssignment.from_database_record(record)
                for record in records
            )
            chain = FallbackChain.from_assignments(assignments)
        except RoutingModelError as exc:
            raise RoutingConfigurationError(
                f"Invalid routing configuration for "
                f"{request.component_id}: {exc}"
            ) from exc

        self._validate_component_consistency(
            component=component,
            assignments=assignments,
        )

        self._validate_request_privacy(
            request=request,
            component=component,
        )

        return RoutingDecision(
            request=request,
            component_name=chain.primary.component_name,
            task_type=chain.primary.task_type,
            privacy_tier=chain.primary.component_privacy_tier,
            routing_mode=chain.primary.routing_mode,
            chain=chain,
        )

    @staticmethod
    def _validate_component_consistency(
        *,
        component: ComponentRecord,
        assignments: Sequence[ModelAssignment],
    ) -> None:
        """Ensure assignments match the registered component."""

        for assignment in assignments:
            if assignment.component_id != component.component_id:
                raise RoutingConfigurationError(
                    "Assignment component mismatch: "
                    f"expected {component.component_id}, "
                    f"received {assignment.component_id}"
                )

            if (
                assignment.component_privacy_tier.value
                != component.privacy_tier
            ):
                raise RoutingConfigurationError(
                    "Assignment privacy tier does not match "
                    f"registered component {component.component_id}"
                )

            if assignment.task_type != component.task_type:
                raise RoutingConfigurationError(
                    "Assignment task type does not match "
                    f"registered component {component.component_id}"
                )

    @staticmethod
    def _validate_request_privacy(
        *,
        request: RoutingRequest,
        component: ComponentRecord,
    ) -> None:
        """Prevent callers from weakening stored privacy requirements."""

        if request.privacy_tier is None:
            return

        try:
            stored_privacy = PrivacyTier(component.privacy_tier)
        except ValueError as exc:
            raise RoutingConfigurationError(
                "Unsupported registered privacy tier: "
                f"{component.privacy_tier}"
            ) from exc

        if request.privacy_tier is not stored_privacy:
            raise PrivacyMismatchError(
                "Requested privacy tier does not match the registered "
                f"component policy: requested="
                f"{request.privacy_tier.value}, "
                f"registered={stored_privacy.value}"
            )


def build_router_from_environment() -> AIRouter:
    """Create the runtime router from database environment variables."""

    from tools.ai_intelligence.database import DatabaseConfig

    return AIRouter(
        database=AIIntelligenceDatabase(
            DatabaseConfig.from_env()
        )
    )
