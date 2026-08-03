#!/usr/bin/env python3
"""
Regression tests for quick skill validation.
"""

import tempfile
from pathlib import Path
from unittest import TestCase, main

import quick_validate


class TestQuickValidate(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_quick_validate_"))

    def tearDown(self):
        import shutil

        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def test_accepts_crlf_frontmatter(self):
        skill_dir = self.temp_dir / "crlf-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\r\nname: crlf-skill\r\ndescription: ok\r\n---\r\n# Skill\r\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertTrue(valid, message)

    def test_rejects_missing_frontmatter_closing_fence(self):
        skill_dir = self.temp_dir / "bad-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\nname: bad-skill\ndescription: missing end\n# no closing fence\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Invalid frontmatter format")

    def test_fallback_parser_handles_multiline_frontmatter_without_pyyaml(self):
        skill_dir = self.temp_dir / "multiline-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: multiline-skill
description: Works without pyyaml
allowed-tools:
  - gh
metadata: |
  {
    "owners": ["team-openclaw"]
  }
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        previous_yaml = quick_validate.yaml
        quick_validate.yaml = None
        try:
            valid, message = quick_validate.validate_skill(skill_dir)
        finally:
            quick_validate.yaml = previous_yaml

        self.assertTrue(valid, message)

    def test_rejects_empty_name(self):
        skill_dir = self.temp_dir / "empty-name-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = '---\nname: ""\ndescription: a valid description\n---\n# Skill\n'
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Name must not be empty")

    def test_rejects_whitespace_only_name(self):
        skill_dir = self.temp_dir / "ws-name-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\nname: '   '\ndescription: a valid description\n---\n# Skill\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Name must not be empty")

    def test_rejects_empty_description(self):
        skill_dir = self.temp_dir / "empty-desc-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = '---\nname: valid-skill\ndescription: ""\n---\n# Skill\n'
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Description must not be empty")

    def test_rejects_whitespace_only_description(self):
        skill_dir = self.temp_dir / "ws-desc-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\nname: valid-skill\ndescription: '   '\n---\n# Skill\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Description must not be empty")


if __name__ == "__main__":
    main()
