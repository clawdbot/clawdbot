from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("ranchbrain-review.py")
SPEC = importlib.util.spec_from_file_location("ranchbrain_review", MODULE_PATH)
assert SPEC is not None
assert SPEC.loader is not None
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)


class RanchBrainApprovedRejectionTests(unittest.TestCase):
    def test_reject_moves_approved_note_to_archive_and_updates_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root / "notes"
            archive = root / "archive"
            notes.mkdir()
            source = notes / "mistake.md"
            source.write_text("---\nstatus: approved\n---\nMistake\n")

            cursor = mock.Mock()
            cursor.fetchone.return_value = (
                "Mistake",
                str(source),
                "ranchbrain_note",
            )
            connection = mock.Mock()
            connection.cursor.return_value = cursor

            with (
                mock.patch.object(review, "database_connection", return_value=connection),
                mock.patch.object(review, "ARCHIVE_DIR", archive),
            ):
                result = review.reject_note(42)

            archived = archive / "mistake.md"
            self.assertFalse(source.exists())
            self.assertTrue(archived.exists())
            self.assertIn("status: rejected", archived.read_text())
            self.assertIn("Memory ID: 42", result)
            update_query = cursor.execute.call_args_list[1].args[0]
            self.assertIn("category = 'ranchbrain_rejected'", update_query)
            connection.commit.assert_called_once()

    def test_rejection_failure_restores_approved_file_and_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root / "notes"
            archive = root / "archive"
            notes.mkdir()
            source = notes / "mistake.md"
            source.write_text("---\nstatus: approved\n---\nMistake\n")

            cursor = mock.Mock()
            cursor.fetchone.return_value = (
                "Mistake",
                str(source),
                "ranchbrain_note",
            )
            cursor.execute.side_effect = [None, RuntimeError("database failure")]
            connection = mock.Mock()
            connection.cursor.return_value = cursor

            with (
                mock.patch.object(review, "database_connection", return_value=connection),
                mock.patch.object(review, "ARCHIVE_DIR", archive),
                self.assertRaisesRegex(RuntimeError, "database failure"),
            ):
                review.reject_note(42)

            self.assertTrue(source.exists())
            self.assertIn("status: approved", source.read_text())
            self.assertFalse((archive / "mistake.md").exists())
            connection.rollback.assert_called_once()


if __name__ == "__main__":
    unittest.main()
