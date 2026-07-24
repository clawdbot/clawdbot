"""Unit tests for the Runtime AI Router decision engine."""

from __future__ import annotations

import unittest
from dataclasses import replace

from tools.ai_intelligence.database import (
    ComponentRecord,
    DeploymentAssignmentRecord,
)
from tools.ai_intelligence.router import (
    AIRouter,
    ComponentInactiveError,
    ComponentNotFoundError,
    ComponentNotRoutableError,
    PrivacyMismatchError,
    RoutingConfigurationError,
)
from tools.ai_intelligence.routing_models import (
    PrivacyTier,
    RoutingRequest,
)


def component(
    *,
    component_id: str = "ranchbrain",
    privacy_tier: str = "local",
    task_type: str = "knowledge",
    active: bool = True,
    metadata: dict | None = None,
) -> ComponentRecord:
    return ComponentRecord(
        component_id=component_id,
        display_name="RanchBrain",
        description="Knowledge system",
        privacy_tier=privacy_tier,
        task_type=task_type,
        active=active,
        metadata=metadata or {},
    )


def assignment(
    *,
    assignment_type: str,
    priority: int,
    model_id: str,
    component_id: str = "ranchbrain",
    privacy_tier: str = "local",
    task_type: str = "knowledge",
) -> DeploymentAssignmentRecord:
    return DeploymentAssignmentRecord(
        component_id=component_id,
        component_name="RanchBrain",
        component_privacy_tier=privacy_tier,
        task_type=task_type,
        assignment_type=assignment_type,
        priority=priority,
        model_id=model_id,
        model_name=model_id,
        provider="ollama",
        deployment="local",
        model_status="active",
        routing_mode="production-safe",
        configuration_source="deployment_map.json",
        assignment_reason="Configured assignment",
        human_approved=True,
        effective_from=None,
    )


class FakeDatabase:
    def __init__(
        self,
        *,
        stored_component: ComponentRecord | None,
        assignments: tuple[DeploymentAssignmentRecord, ...] = (),
    ) -> None:
        self.stored_component = stored_component
        self.assignments = assignments

    def get_component(
        self,
        component_id: str,
    ) -> ComponentRecord | None:
        return self.stored_component

    def get_active_assignments(
        self,
        component_id: str,
    ) -> tuple[DeploymentAssignmentRecord, ...]:
        return self.assignments


class AIRouterTests(unittest.TestCase):
    def test_returns_valid_routing_decision(self) -> None:
        database = FakeDatabase(
            stored_component=component(),
            assignments=(
                assignment(
                    assignment_type="fallback",
                    priority=2,
                    model_id="ollama-llama3.2-3b",
                ),
                assignment(
                    assignment_type="primary",
                    priority=1,
                    model_id="ollama-hermes3-8b",
                ),
                assignment(
                    assignment_type="fallback",
                    priority=1,
                    model_id="ollama-gemma3-12b",
                ),
            ),
        )

        decision = AIRouter(database).route(
            RoutingRequest(component_id="ranchbrain")
        )

        self.assertEqual(
            decision.candidate_model_ids,
            (
                "ollama-hermes3-8b",
                "ollama-gemma3-12b",
                "ollama-llama3.2-3b",
            ),
        )

    def test_unknown_component_is_rejected(self) -> None:
        router = AIRouter(
            FakeDatabase(stored_component=None)
        )

        with self.assertRaises(ComponentNotFoundError):
            router.route(
                RoutingRequest(component_id="missing")
            )

    def test_inactive_component_is_rejected(self) -> None:
        router = AIRouter(
            FakeDatabase(
                stored_component=component(active=False)
            )
        )

        with self.assertRaises(ComponentInactiveError):
            router.route(
                RoutingRequest(component_id="ranchbrain")
            )

    def test_non_model_serving_component_is_rejected_cleanly(
        self,
    ) -> None:
        router = AIRouter(
            FakeDatabase(
                stored_component=component(
                    component_id="ranchbrain_dashboard",
                    task_type="presentation",
                    metadata={
                        "verification_status": "not-model-serving"
                    },
                )
            )
        )

        with self.assertRaises(ComponentNotRoutableError):
            router.route(
                RoutingRequest(
                    component_id="ranchbrain_dashboard"
                )
            )

    def test_unassigned_model_serving_component_is_configuration_error(
        self,
    ) -> None:
        router = AIRouter(
            FakeDatabase(stored_component=component())
        )

        with self.assertRaises(RoutingConfigurationError):
            router.route(
                RoutingRequest(component_id="ranchbrain")
            )

    def test_privacy_override_is_rejected(self) -> None:
        router = AIRouter(
            FakeDatabase(
                stored_component=component(),
                assignments=(
                    assignment(
                        assignment_type="primary",
                        priority=1,
                        model_id="ollama-hermes3-8b",
                    ),
                ),
            )
        )

        with self.assertRaises(PrivacyMismatchError):
            router.route(
                RoutingRequest(
                    component_id="ranchbrain",
                    privacy_tier=PrivacyTier.MIXED,
                )
            )

    def test_assignment_privacy_drift_is_rejected(self) -> None:
        router = AIRouter(
            FakeDatabase(
                stored_component=component(),
                assignments=(
                    assignment(
                        assignment_type="primary",
                        priority=1,
                        model_id="ollama-hermes3-8b",
                        privacy_tier="mixed",
                    ),
                ),
            )
        )

        with self.assertRaises(RoutingConfigurationError):
            router.route(
                RoutingRequest(component_id="ranchbrain")
            )

    def test_multiple_primary_assignments_are_rejected(self) -> None:
        router = AIRouter(
            FakeDatabase(
                stored_component=component(),
                assignments=(
                    assignment(
                        assignment_type="primary",
                        priority=1,
                        model_id="ollama-hermes3-8b",
                    ),
                    assignment(
                        assignment_type="primary",
                        priority=2,
                        model_id="ollama-gemma3-12b",
                    ),
                ),
            )
        )

        with self.assertRaises(RoutingConfigurationError):
            router.route(
                RoutingRequest(component_id="ranchbrain")
            )


if __name__ == "__main__":
    unittest.main()
