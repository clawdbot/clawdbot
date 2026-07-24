"""Unit tests for typed Runtime AI Router models."""

from __future__ import annotations

import unittest

from tools.ai_intelligence.database import DeploymentAssignmentRecord
from tools.ai_intelligence.routing_models import (
    AssignmentType,
    FallbackChain,
    ModelAssignment,
    PrivacyTier,
    RoutingDecision,
    RoutingMode,
    RoutingModelError,
    RoutingRequest,
)


def make_assignment(
    *,
    assignment_type: AssignmentType,
    priority: int,
    model_id: str,
    deployment: str = "local",
) -> ModelAssignment:
    return ModelAssignment(
        component_id="ranchbrain",
        component_name="RanchBrain",
        component_privacy_tier=PrivacyTier.LOCAL,
        task_type="knowledge",
        assignment_type=assignment_type,
        priority=priority,
        model_id=model_id,
        model_name=model_id,
        provider="ollama",
        deployment=deployment,
        model_status="active",
        routing_mode=RoutingMode.PRODUCTION_SAFE,
        human_approved=True,
    )


class RoutingRequestTests(unittest.TestCase):
    def test_rejects_blank_component_id(self) -> None:
        with self.assertRaises(RoutingModelError):
            RoutingRequest(component_id="   ")


class ModelAssignmentTests(unittest.TestCase):
    def test_primary_and_local_properties(self) -> None:
        assignment = make_assignment(
            assignment_type=AssignmentType.PRIMARY,
            priority=1,
            model_id="ollama-hermes3-8b",
        )

        self.assertTrue(assignment.is_primary)
        self.assertTrue(assignment.is_local)

    def test_rejects_invalid_priority(self) -> None:
        with self.assertRaises(RoutingModelError):
            make_assignment(
                assignment_type=AssignmentType.PRIMARY,
                priority=0,
                model_id="ollama-hermes3-8b",
            )

    def test_from_database_record(self) -> None:
        record = DeploymentAssignmentRecord(
            component_id="ranchbrain",
            component_name="RanchBrain",
            component_privacy_tier="local",
            task_type="knowledge",
            assignment_type="primary",
            priority=1,
            model_id="ollama-hermes3-8b",
            model_name="Hermes 3 8B",
            provider="ollama",
            deployment="local",
            model_status="active",
            routing_mode="production-safe",
            configuration_source="deployment_map.json",
            assignment_reason="Primary local model",
            human_approved=True,
            effective_from=None,
        )

        assignment = ModelAssignment.from_database_record(record)

        self.assertEqual(
            assignment.component_privacy_tier,
            PrivacyTier.LOCAL,
        )
        self.assertEqual(
            assignment.assignment_type,
            AssignmentType.PRIMARY,
        )
        self.assertEqual(
            assignment.routing_mode,
            RoutingMode.PRODUCTION_SAFE,
        )


class FallbackChainTests(unittest.TestCase):
    def test_builds_ordered_chain(self) -> None:
        primary = make_assignment(
            assignment_type=AssignmentType.PRIMARY,
            priority=1,
            model_id="ollama-hermes3-8b",
        )
        fallback_two = make_assignment(
            assignment_type=AssignmentType.FALLBACK,
            priority=2,
            model_id="ollama-llama3.2-3b",
        )
        fallback_one = make_assignment(
            assignment_type=AssignmentType.FALLBACK,
            priority=1,
            model_id="ollama-gemma3-12b",
        )

        chain = FallbackChain.from_assignments(
            [fallback_two, primary, fallback_one]
        )

        self.assertEqual(
            tuple(
                assignment.model_id
                for assignment in chain.ordered_candidates
            ),
            (
                "ollama-hermes3-8b",
                "ollama-gemma3-12b",
                "ollama-llama3.2-3b",
            ),
        )

    def test_rejects_missing_primary(self) -> None:
        fallback = make_assignment(
            assignment_type=AssignmentType.FALLBACK,
            priority=1,
            model_id="ollama-gemma3-12b",
        )

        with self.assertRaises(RoutingModelError):
            FallbackChain.from_assignments([fallback])

    def test_rejects_duplicate_model_ids(self) -> None:
        primary = make_assignment(
            assignment_type=AssignmentType.PRIMARY,
            priority=1,
            model_id="ollama-hermes3-8b",
        )
        fallback = make_assignment(
            assignment_type=AssignmentType.FALLBACK,
            priority=1,
            model_id="ollama-hermes3-8b",
        )

        with self.assertRaises(RoutingModelError):
            FallbackChain.from_assignments([primary, fallback])


class RoutingDecisionTests(unittest.TestCase):
    def test_returns_candidate_model_ids(self) -> None:
        primary = make_assignment(
            assignment_type=AssignmentType.PRIMARY,
            priority=1,
            model_id="ollama-hermes3-8b",
        )
        fallback = make_assignment(
            assignment_type=AssignmentType.FALLBACK,
            priority=1,
            model_id="ollama-gemma3-12b",
        )

        decision = RoutingDecision(
            request=RoutingRequest(component_id="ranchbrain"),
            component_name="RanchBrain",
            task_type="knowledge",
            privacy_tier=PrivacyTier.LOCAL,
            routing_mode=RoutingMode.PRODUCTION_SAFE,
            chain=FallbackChain.from_assignments(
                [primary, fallback]
            ),
        )

        self.assertEqual(
            decision.candidate_model_ids,
            (
                "ollama-hermes3-8b",
                "ollama-gemma3-12b",
            ),
        )


if __name__ == "__main__":
    unittest.main()
