"""Unit tests for the AI Intelligence PostgreSQL adapter."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from tools.ai_intelligence.database import (
    AIIntelligenceDatabase,
    DatabaseConfig,
    DatabaseConfigurationError,
)


class DatabaseConfigTests(unittest.TestCase):
    def test_from_env_builds_config(self) -> None:
        config = DatabaseConfig.from_env(
            {
                "OPENCLAW_DB_HOST": "127.0.0.1",
                "OPENCLAW_DB_PORT": "55432",
                "OPENCLAW_DB_NAME": "openclaw_ai_dev",
                "OPENCLAW_DB_USER": "openclaw",
                "OPENCLAW_DB_PASSWORD": "secret",
            }
        )

        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 55432)
        self.assertEqual(config.dbname, "openclaw_ai_dev")

    def test_from_env_rejects_missing_values(self) -> None:
        with self.assertRaises(DatabaseConfigurationError):
            DatabaseConfig.from_env({})

    def test_from_env_rejects_invalid_port(self) -> None:
        with self.assertRaises(DatabaseConfigurationError):
            DatabaseConfig.from_env(
                {
                    "OPENCLAW_DB_HOST": "127.0.0.1",
                    "OPENCLAW_DB_PORT": "not-a-port",
                    "OPENCLAW_DB_NAME": "openclaw_ai_dev",
                    "OPENCLAW_DB_USER": "openclaw",
                    "OPENCLAW_DB_PASSWORD": "secret",
                }
            )


class AIIntelligenceDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = MagicMock()
        self.cursor = MagicMock()

        self.connection.cursor.return_value.__enter__.return_value = (
            self.cursor
        )

        self.connect_factory = MagicMock(
            return_value=self.connection
        )

        self.database = AIIntelligenceDatabase(
            DatabaseConfig(
                host="127.0.0.1",
                port=55432,
                dbname="openclaw_ai_dev",
                user="openclaw",
                password="secret",
            ),
            connect_factory=self.connect_factory,
        )

    def test_get_component_returns_component_record(self) -> None:
        self.cursor.fetchone.return_value = {
            "component_id": "ranchbrain",
            "display_name": "RanchBrain",
            "description": "Knowledge system",
            "privacy_tier": "local",
            "task_type": "knowledge",
            "active": True,
            "component_metadata": {"loader_managed": True},
        }

        result = self.database.get_component("ranchbrain")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.component_id, "ranchbrain")
        self.assertEqual(result.privacy_tier, "local")
        self.assertTrue(result.active)

    def test_get_component_returns_none_when_missing(self) -> None:
        self.cursor.fetchone.return_value = None

        result = self.database.get_component("missing")

        self.assertIsNone(result)

    def test_get_active_assignments_maps_rows(self) -> None:
        self.cursor.fetchall.return_value = [
            {
                "component_id": "ranchbrain",
                "component_name": "RanchBrain",
                "component_privacy_tier": "local",
                "task_type": "knowledge",
                "assignment_type": "primary",
                "priority": 1,
                "model_id": "ollama-hermes3-8b",
                "model_name": "Hermes 3 8B",
                "provider": "ollama",
                "deployment": "local",
                "model_status": "active",
                "routing_mode": "local_first",
                "configuration_source": "deployment_map.json",
                "assignment_reason": "Primary local model",
                "human_approved": True,
                "effective_from": None,
            }
        ]

        result = self.database.get_active_assignments("ranchbrain")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].assignment_type, "primary")
        self.assertEqual(result[0].model_id, "ollama-hermes3-8b")

    def test_connection_is_read_only_and_closed(self) -> None:
        self.cursor.fetchall.return_value = []

        self.database.list_routable_component_ids()

        self.connection.set_session.assert_called_once_with(
            readonly=True,
            autocommit=True,
        )
        self.connection.close.assert_called_once()

    def test_record_observed_usage_writes_through_writable_connection(
        self,
    ) -> None:
        self.database.record_observed_usage(
            component_id="telegram_ranch_bot",
            model_id="ollama-hermes3-8b",
            request_id="req-1",
            task_type="conversation",
            routing_mode="production-safe",
            selected_as="primary",
            success=True,
            duration_ms=12,
            privacy_tier="local",
            usage_metadata={"failover_occurred": False},
        )

        self.connection.set_session.assert_called_once_with(
            readonly=False,
            autocommit=True,
        )
        self.assertTrue(self.cursor.execute.called)
        sql = self.cursor.execute.call_args.args[0]
        self.assertIn(
            "INSERT INTO ai_intelligence.observed_model_usage",
            sql,
        )

    def test_list_deployment_drift_maps_rows(self) -> None:
        self.cursor.fetchall.return_value = [
            {
                "component_id": "telegram_ranch_bot",
                "component_name": "Telegram Ranch Bot",
                "configured_primary_model": "ollama-hermes3-8b",
                "latest_observed_model": "ollama-llama3.2-3b",
                "observed_at": None,
                "deployment_status": "drift",
            }
        ]

        rows = self.database.list_deployment_drift()

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["deployment_status"], "drift")


if __name__ == "__main__":
    unittest.main()
