from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "tools" / "ai_intelligence" / "load_configuration.py"

SPEC = importlib.util.spec_from_file_location(
    "load_configuration",
    MODULE_PATH,
)

if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to import load_configuration.py")

MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ConfigurationLoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.plan = MODULE.build_plan()

    def test_expected_model_count(self) -> None:
        self.assertEqual(len(self.plan.models), 9)

    def test_expected_benchmark_count(self) -> None:
        self.assertEqual(len(self.plan.benchmarks), 10)

    def test_expected_component_count(self) -> None:
        self.assertEqual(len(self.plan.components), 10)

    def test_model_ids_are_unique(self) -> None:
        model_ids = [item["model_id"] for item in self.plan.models]
        self.assertEqual(len(model_ids), len(set(model_ids)))

    def test_benchmark_ids_are_unique(self) -> None:
        benchmark_ids = [
            item["benchmark_id"]
            for item in self.plan.benchmarks
        ]
        self.assertEqual(
            len(benchmark_ids),
            len(set(benchmark_ids)),
        )

    def test_component_ids_are_unique(self) -> None:
        component_ids = [
            item["component_id"]
            for item in self.plan.components
        ]
        self.assertEqual(
            len(component_ids),
            len(set(component_ids)),
        )

    def test_every_assignment_references_known_model(self) -> None:
        model_ids = {
            item["model_id"]
            for item in self.plan.models
        }

        for assignment in self.plan.assignments:
            self.assertIn(assignment["model_id"], model_ids)

    def test_assignment_keys_are_unique(self) -> None:
        keys = MODULE.desired_assignment_keys(self.plan)
        self.assertEqual(len(keys), len(set(keys)))

    def test_ranchbrain_primary_model_is_local(self) -> None:
        model_lookup = {
            item["model_id"]: item
            for item in self.plan.models
        }

        ranchbrain = [
            item
            for item in self.plan.assignments
            if item["component_id"] == "ranchbrain"
            and item["assignment_type"] == "primary"
        ]

        self.assertEqual(len(ranchbrain), 1)

        selected_model = model_lookup[ranchbrain[0]["model_id"]]
        self.assertEqual(selected_model["deployment"], "local")

    def test_property_manager_primary_model_is_local(self) -> None:
        model_lookup = {
            item["model_id"]: item
            for item in self.plan.models
        }

        property_manager = [
            item
            for item in self.plan.assignments
            if item["component_id"] == "property_manager"
            and item["assignment_type"] == "primary"
        ]

        self.assertEqual(len(property_manager), 1)

        selected_model = model_lookup[
            property_manager[0]["model_id"]
        ]
        self.assertEqual(selected_model["deployment"], "local")

    def test_generated_sql_is_transactional(self) -> None:
        sql = MODULE.build_sql(self.plan)

        self.assertIn("BEGIN;", sql)
        self.assertIn("COMMIT;", sql)
        self.assertIn("\\set ON_ERROR_STOP on", sql)

    def test_generated_sql_uses_updates_and_guarded_inserts(self) -> None:
        sql = MODULE.build_sql(self.plan)

        self.assertIn(
            "ON CONFLICT (model_id)",
            sql,
        )
        self.assertIn(
            "ON CONFLICT (benchmark_id)",
            sql,
        )
        self.assertIn(
            "ON CONFLICT (component_id)",
            sql,
        )
        self.assertIn(
            "WHERE NOT EXISTS",
            sql,
        )


if __name__ == "__main__":
    unittest.main()
