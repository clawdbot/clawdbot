"""Tests for scorecard approval and promotion helpers."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.ai_intelligence.approve_evaluation_lab import (
    eligible_candidates,
    resolve_evaluation_path,
)
from tools.ai_intelligence.promote_approved_scorecard import atomic_json


class ScorecardWorkflowTests(unittest.TestCase):
    def test_evaluation_path_rejects_files_outside_report_directory(self) -> None:
        with self.assertRaises(ValueError):
            resolve_evaluation_path("/tmp/not-an-evaluation.json")

    def test_only_validated_winners_are_approval_candidates(self) -> None:
        candidates = eligible_candidates(
            {
                "benchmark_reconciliation": {
                    "approved": {
                        "promotion_eligible": True,
                        "winner_passed_deterministic_validation": True,
                        "final_winner": "gemma3:12b",
                        "final_status": "passed",
                    },
                    "unvalidated": {
                        "promotion_eligible": True,
                        "winner_passed_deterministic_validation": False,
                        "final_winner": "other:model",
                    },
                }
            }
        )

        self.assertEqual(
            [candidate["benchmark_id"] for candidate in candidates],
            ["approved"],
        )

    def test_atomic_json_creates_a_new_audit_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "audit.json"

            atomic_json(path, {"status": "applied"})

            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8")),
                {"status": "applied"},
            )
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()
