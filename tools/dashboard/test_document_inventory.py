from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.dashboard.document_inventory import (
    ensure_document_inventory,
    inventory_is_current,
)


class DocumentInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.docs = self.root / "docs"
        self.docs.mkdir()
        self.inventory = self.docs / "document-inventory.json"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_document(self, relative_path: str, content: str) -> Path:
        path = self.docs / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_generates_inventory_with_frontmatter(self):
        self.write_document(
            "foundation/example.md",
            """---
title: "Example Requirement"
status: "Foundational"
owner: "Operator"
category: "Governance"
---

# Ignored fallback
""",
        )

        result = ensure_document_inventory(self.docs, self.inventory)

        self.assertEqual(result["document_count"], 1)
        self.assertEqual(result["documents"][0]["title"], "Example Requirement")
        self.assertEqual(result["documents"][0]["category"], "Governance")
        self.assertTrue(result["documents"][0]["metadata_present"])
        self.assertTrue(inventory_is_current(self.docs, self.inventory))

    def test_refreshes_after_document_add_edit_and_delete(self):
        first = self.write_document("first.md", "# First\n")
        initial = ensure_document_inventory(self.docs, self.inventory)

        self.write_document("second.md", "# Second\n")
        after_add = ensure_document_inventory(self.docs, self.inventory)
        self.assertNotEqual(initial["source_fingerprint"], after_add["source_fingerprint"])
        self.assertEqual(after_add["document_count"], 2)

        # A content fingerprint catches edits even when the byte count is unchanged.
        first.write_text("# Other\n", encoding="utf-8")
        after_edit = ensure_document_inventory(self.docs, self.inventory)
        self.assertNotEqual(after_add["source_fingerprint"], after_edit["source_fingerprint"])
        self.assertEqual(
            next(item for item in after_edit["documents"] if item["relative_path"] == "first.md")[
                "title"
            ],
            "Other",
        )

        (self.docs / "second.md").unlink()
        after_delete = ensure_document_inventory(self.docs, self.inventory)
        self.assertEqual(after_delete["document_count"], 1)
        self.assertTrue(inventory_is_current(self.docs, self.inventory))

    def test_corrupt_inventory_is_replaced_atomically(self):
        self.write_document("example.md", "# Example\n")
        self.inventory.write_text("{not-json", encoding="utf-8")

        result = ensure_document_inventory(self.docs, self.inventory)
        persisted = json.loads(self.inventory.read_text(encoding="utf-8"))

        self.assertEqual(persisted["source_fingerprint"], result["source_fingerprint"])
        self.assertEqual(persisted["document_count"], 1)


if __name__ == "__main__":
    unittest.main()
