#!/usr/bin/env python3
"""Tests for the Benchmark Evidence Database foundation."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

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


class DatabaseFoundationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.deployment = json.loads(
            DEPLOYMENT_PATH.read_text(encoding="utf-8")
        )
        cls.sql = MIGRATION_PATH.read_text(
            encoding="utf-8"
        )

    def test_expected_components_exist(self):
        component_ids = {
            component["id"]
            for component in self.deployment["components"]
        }

        expected = {
            "ranchbrain",
            "property_manager",
            "telegram_ranch_bot",
            "home_assistant",
            "daily_executive_briefing",
            "openclaw_engineering",
            "swift_property_manager",
            "knowledge_ingestion",
            "embedding_service",
            "ranchbrain_dashboard",
        }

        self.assertTrue(expected <= component_ids)

    def test_ranchbrain_is_local(self):
        ranchbrain = next(
            component
            for component in self.deployment["components"]
            if component["id"] == "ranchbrain"
        )

        self.assertEqual(
            ranchbrain["privacy_tier"],
            "local",
        )
        self.assertTrue(
            ranchbrain["primary_model"].startswith("ollama-")
        )

    def test_property_manager_is_local(self):
        property_manager = next(
            component
            for component in self.deployment["components"]
            if component["id"] == "property_manager"
        )

        self.assertEqual(
            property_manager["privacy_tier"],
            "local",
        )
        self.assertNotEqual(
            property_manager["primary_model"],
            "openai-frontier",
        )

    def test_database_tracks_observed_usage(self):
        self.assertIn(
            "observed_model_usage",
            self.sql,
        )

    def test_database_detects_deployment_drift(self):
        self.assertIn(
            "ai_intelligence.deployment_drift",
            self.sql,
        )

    def test_database_preserves_assignment_history(self):
        self.assertIn(
            "assignment_history",
            self.sql,
        )

    def test_database_preserves_promotion_history(self):
        self.assertIn(
            "promotion_history",
            self.sql,
        )

    def test_migration_is_transactional(self):
        stripped = self.sql.strip()

        self.assertTrue(stripped.startswith("BEGIN;"))
        self.assertTrue(stripped.endswith("COMMIT;"))


if __name__ == "__main__":
    unittest.main()
