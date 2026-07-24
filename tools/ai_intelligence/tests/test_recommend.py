#!/usr/bin/env python3
"""Tests for the AI Intelligence recommendation engine."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "recommend.py"
)

SPEC = importlib.util.spec_from_file_location(
    "ai_recommend",
    MODULE_PATH,
)

assert SPEC is not None
assert SPEC.loader is not None

recommend_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recommend_module)


class RecommendationTests(unittest.TestCase):
    def test_every_known_task_returns_a_model(self):
        policy = recommend_module.load_json(
            "routing_policy.json"
        )

        for rule in policy["rules"]:
            with self.subTest(task=rule["task"]):
                result = recommend_module.recommend(
                    rule["task"]
                )
                self.assertTrue(
                    result["recommended_model"]
                )

    def test_private_data_stays_local(self):
        result = recommend_module.recommend(
            "private_property_data"
        )

        self.assertEqual(
            result["privacy_tier"],
            "local",
        )
        self.assertEqual(
            result["deployment"],
            "local",
        )

    def test_routine_query_stays_local(self):
        result = recommend_module.recommend(
            "routine_local_query"
        )

        self.assertEqual(
            result["privacy_tier"],
            "local",
        )

    def test_evaluation_models_are_excluded_by_default(self):
        result = recommend_module.recommend(
            "long_context_engineering"
        )

        eligible_ids = {
            candidate["model_id"]
            for candidate in result["eligible_candidates"]
        }

        self.assertNotIn("claude", eligible_ids)
        self.assertNotIn("kimi-k3", eligible_ids)

    def test_evaluation_mode_includes_evaluation_models(self):
        result = recommend_module.recommend(
            "long_context_engineering",
            include_evaluation=True,
        )

        eligible_ids = {
            candidate["model_id"]
            for candidate in result["eligible_candidates"]
        }

        self.assertIn("claude", eligible_ids)
        self.assertIn("kimi-k3", eligible_ids)

    def test_preferred_model_beats_fallback_group(self):
        result = recommend_module.recommend(
            "private_property_data"
        )

        self.assertEqual(
            result["candidate_group"],
            "preferred",
        )

    def test_unknown_task_raises_value_error(self):
        with self.assertRaises(ValueError):
            recommend_module.recommend(
                "not-a-real-task"
            )


if __name__ == "__main__":
    unittest.main()
