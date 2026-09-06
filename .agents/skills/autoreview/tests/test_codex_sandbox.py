#!/usr/bin/env python3
"""Exercise the real macOS tool sandbox, not a mocked Codex verdict."""

import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parents[1] / "scripts" / "autoreview"


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("codex"), "requires macOS and Codex")
class CodexSandboxTests(unittest.TestCase):
    def test_shared_scratch_is_denied_but_workspace_remains_read_only(self):
        helper = runpy.run_path(str(HELPER), run_name="autoreview_under_test")
        private_temp_root = Path(tempfile.gettempdir()).resolve()
        for scratch_root in ("/private/tmp", "/private/var/tmp"):
            self.assertFalse(
                private_temp_root.is_relative_to(scratch_root),
                "sandbox positive control requires the macOS private temporary directory",
            )
        for scratch_root in ("/private/tmp", "/private/var/tmp"):
            with (
                self.subTest(root=scratch_root),
                tempfile.TemporaryDirectory(
                    prefix="autoreview-sandbox-test.", dir=private_temp_root,
                ) as private_temp,
                tempfile.TemporaryDirectory(
                    prefix="autoreview-scratch-test.", dir=scratch_root,
                ) as scratch,
            ):
                root = Path(private_temp).resolve()
                workspace = root / "workspace"
                workspace.mkdir()
                inside = workspace / "inside.txt"
                outside = Path(scratch) / "outside.txt"
                inside.write_text("owned inside\n")
                outside.write_text("owned outside\n")
                flags = helper["codex_config_isolation_flags"](workspace, root / "runtime")
                runtime_file = root / "runtime" / "synthetic-auth.txt"
                runtime_file.write_text("synthetic runtime sentinel\n")
                scratch_link = workspace / "scratch-link"
                scratch_link.symlink_to(outside)
                runtime_link = workspace / "runtime-link"
                runtime_link.symlink_to(runtime_file)
                alias = Path(str(outside).removeprefix("/private"))
                for path in (outside, alias, scratch_link):
                    self.assertEqual(path.read_text(), "owned outside\n")
                self.assertEqual(runtime_link.read_text(), "synthetic runtime sentinel\n")
                subprocess.run(
                    ["/bin/ls", "-f", scratch_root], check=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                )
                result = subprocess.run(
                    [
                        shutil.which("codex"), "sandbox", "--include-managed-config",
                        "--permission-profile", "autoreview", *flags, "-C", str(workspace),
                        "--", "/bin/sh", "-c",
                        '''
                        fail=0
                        test "$(cat "$1")" = "owned inside" || fail=1
                        if cat "$2" >/dev/null; then echo outside-read-allowed; fail=1; fi
                        if cat "$3" >/dev/null; then echo alias-read-allowed; fail=1; fi
                        if ls -f "$4" >/dev/null; then echo root-list-allowed; fail=1; fi
                        if (printf unexpected >> "$2"); then echo outside-write-allowed; fail=1; fi
                        if (printf unexpected >> "$1"); then echo inside-write-allowed; fail=1; fi
                        if touch "$5"; then echo outside-create-allowed; fail=1; fi
                        if cat "$6" >/dev/null; then echo scratch-link-read-allowed; fail=1; fi
                        if cat "$7" >/dev/null; then echo runtime-link-read-allowed; fail=1; fi
                        exit "$fail"
                        ''',
                        "sandbox-test", str(inside), str(outside), str(alias), scratch_root,
                        str(Path(scratch) / "created"), str(scratch_link), str(runtime_link),
                    ],
                    capture_output=True, text=True, timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(inside.read_text(), "owned inside\n")
                self.assertEqual(outside.read_text(), "owned outside\n")
                self.assertEqual(runtime_file.read_text(), "synthetic runtime sentinel\n")
                self.assertFalse((Path(scratch) / "created").exists())


if __name__ == "__main__":
    unittest.main()
