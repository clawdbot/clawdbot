#!/usr/bin/env python3
"""
Regression tests for skill packaging security behavior.
"""

import sys
import tempfile
import types
import zipfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


fake_quick_validate = types.ModuleType("quick_validate")
fake_quick_validate.validate_skill = lambda _path: (True, "Skill is valid!")
original_quick_validate = sys.modules.get("quick_validate")
sys.modules["quick_validate"] = fake_quick_validate

import package_skill as package_skill_module

package_skill = package_skill_module.package_skill

if original_quick_validate is not None:
    sys.modules["quick_validate"] = original_quick_validate
else:
    sys.modules.pop("quick_validate", None)


class TestPackageSkillSecurity(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_skill_"))

    def tearDown(self):
        import shutil

        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def create_skill(self, name="test-skill"):
        skill_dir = self.temp_dir / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text("---\nname: test-skill\ndescription: test\n---\n")
        (skill_dir / "script.py").write_text("print('ok')\n")
        return skill_dir

    def test_packages_normal_files(self):
        skill_dir = self.create_skill("normal-skill")
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        result = package_skill(str(skill_dir), str(out_dir))

        self.assertIsNotNone(result)
        skill_file = out_dir / "normal-skill.skill"
        self.assertTrue(skill_file.exists())
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("normal-skill/SKILL.md", names)
        self.assertIn("normal-skill/script.py", names)

    def test_skips_symlink_to_external_file(self):
        skill_dir = self.create_skill("symlink-file-skill")
        outside = self.temp_dir / "outside-secret.txt"
        outside.write_text("super-secret\n")
        link = skill_dir / "loot.txt"
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unsupported on this platform")

        result = package_skill(str(skill_dir), str(out_dir))
        self.assertIsNotNone(result)
        skill_file = out_dir / "symlink-file-skill.skill"
        self.assertTrue(skill_file.exists())
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("symlink-file-skill/SKILL.md", names)
        self.assertIn("symlink-file-skill/script.py", names)
        self.assertNotIn("symlink-file-skill/loot.txt", names)

    def test_skips_symlink_directory(self):
        skill_dir = self.create_skill("symlink-dir-skill")
        outside_dir = self.temp_dir / "outside"
        outside_dir.mkdir()
        (outside_dir / "secret.txt").write_text("secret\n")
        link = skill_dir / "docs"
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        try:
            link.symlink_to(outside_dir, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unsupported on this platform")

        result = package_skill(str(skill_dir), str(out_dir))
        self.assertIsNotNone(result)
        skill_file = out_dir / "symlink-dir-skill.skill"
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("symlink-dir-skill/SKILL.md", names)
        self.assertIn("symlink-dir-skill/script.py", names)
        self.assertNotIn("symlink-dir-skill/docs/secret.txt", names)

    def test_rejects_resolved_path_outside_skill_root(self):
        skill_dir = self.create_skill("escape-skill")
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        original_within = package_skill_module._is_within

        def fake_is_within(path_obj: Path, root: Path):
            if path_obj.name == "script.py":
                return False
            return original_within(path_obj, root)

        with patch.object(package_skill_module, "_is_within", fake_is_within):
            result = package_skill(str(skill_dir), str(out_dir))

        self.assertIsNone(result)

    def test_allows_nested_regular_files(self):
        skill_dir = self.create_skill("nested-skill")
        nested = skill_dir / "lib" / "helpers"
        nested.mkdir(parents=True, exist_ok=True)
        (nested / "util.py").write_text("def run():\n    return 1\n")
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        result = package_skill(str(skill_dir), str(out_dir))

        self.assertIsNotNone(result)
        skill_file = out_dir / "nested-skill.skill"
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("nested-skill/lib/helpers/util.py", names)

    def test_skips_output_archive_when_output_dir_is_skill_dir(self):
        skill_dir = self.create_skill("self-output-skill")

        result = package_skill(str(skill_dir), str(skill_dir))

        self.assertIsNotNone(result)
        skill_file = skill_dir / "self-output-skill.skill"
        self.assertTrue(skill_file.exists())
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("self-output-skill/SKILL.md", names)
        self.assertIn("self-output-skill/script.py", names)
        self.assertNotIn("self-output-skill/self-output-skill.skill", names)


if __name__ == "__main__":
    main()
