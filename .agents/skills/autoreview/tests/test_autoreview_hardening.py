#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import runpy
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path, PureWindowsPath


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "autoreview"
FIXTURES = Path(__file__).with_name("fixtures")
PRIVATE_KEY_BEGIN_TEXT = "BEGIN " + "PRIVATE KEY"
RSA_PRIVATE_KEY_BEGIN_TEXT = "BEGIN RSA " + "PRIVATE KEY"


def write_executable(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)
    if os.name != "nt":
        return path
    wrapper = path.with_name(f"{path.name}.cmd")
    wrapper.write_text(f'@echo off\r\n"{sys.executable}" "{path}" %*\r\n', encoding="utf-8")
    return wrapper


def fake_codex_script() -> str:
    return r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

record = os.environ["AUTOREVIEW_FAKE_RECORD"]
args = sys.argv[1:]
Path(record).write_text(json.dumps({"argv": args, "cwd": os.getcwd(), "stdin": sys.stdin.read()}))
if mutation := os.environ.get("AUTOREVIEW_FAKE_MUTATE"):
    Path(mutation).write_text("mutated during review\n")
try:
    output_path = args[args.index("--output-last-message") + 1]
except ValueError:
    output_path = args[args.index("-o") + 1]
report = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "fake codex clean",
    "overall_confidence": 0.99,
}
Path(output_path).write_text(json.dumps(report))
print("fake codex ok")
'''


def fake_claude_script() -> str:
    return r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if "--version" in args or "-v" in args:
    print(os.environ.get("AUTOREVIEW_FAKE_CLAUDE_VERSION", "2.1.170 (Claude Code)"))
    raise SystemExit(0)
if "--help" in args or "-h" in args:
    print("--safe-mode\n--setting-sources\n--strict-mcp-config\n--disallowedTools\n--tools\n--print\n--json-schema")
    raise SystemExit(0)
record = os.environ["AUTOREVIEW_FAKE_RECORD"]
Path(record).write_text(json.dumps({
    "argv": args,
    "cwd": os.getcwd(),
    "stdin": sys.stdin.read(),
    "auto_memory_disabled": os.environ.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY"),
}))
report = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "fake claude clean",
    "overall_confidence": 0.99,
}
print(json.dumps(report))
'''


def fake_pi_script() -> str:
    return r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
invocations = os.environ.get("AUTOREVIEW_FAKE_PI_INVOCATIONS")
if invocations:
    with open(invocations, "a", encoding="utf-8") as file:
        file.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\n")
if "--version" in args or "-v" in args:
    print(os.environ.get("AUTOREVIEW_FAKE_PI_VERSION", "0.79.0"))
    raise SystemExit(0)
if "--help" in args or "-h" in args:
    print(os.environ.get("AUTOREVIEW_FAKE_PI_HELP", "--print\n--no-approve\n--no-session\n--no-context-files\n--no-extensions\n--no-skills\n--no-prompt-templates\n--no-themes\n--tools\n--no-tools\n--thinking"))
    raise SystemExit(0)
record = os.environ["AUTOREVIEW_FAKE_RECORD"]
Path(record).write_text(json.dumps({"argv": args, "cwd": os.getcwd(), "stdin": sys.stdin.read()}))
report = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "fake pi clean",
    "overall_confidence": 0.99,
}
print(json.dumps(report))
	'''


def fake_kimi_script() -> str:
    return r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if "--version" in args or "-v" in args:
    print(os.environ.get("AUTOREVIEW_FAKE_KIMI_VERSION", "0.30.0"))
    raise SystemExit(0)
if "--help" in args or "-h" in args:
    print(os.environ.get("AUTOREVIEW_FAKE_KIMI_HELP", "--agent-file\n--skills-dir\n--prompt\n--output-format\n--model"))
    raise SystemExit(0)
record = os.environ.get("AUTOREVIEW_FAKE_RECORD")
if record:
    Path(record).write_text(json.dumps({"argv": args, "cwd": os.getcwd(), "stdin": sys.stdin.read()}))
report = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "fake kimi clean",
    "overall_confidence": 0.99,
}
print(json.dumps(report))
'''


def load_helper() -> dict[str, object]:
    return runpy.run_path(str(SCRIPT), run_name="autoreview_under_test")


def git(repo: Path, *args: str) -> str:
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": "Autoreview Test",
            "GIT_AUTHOR_EMAIL": "autoreview@example.invalid",
            "GIT_COMMITTER_NAME": "Autoreview Test",
            "GIT_COMMITTER_EMAIL": "autoreview@example.invalid",
        }
    )
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        env=env,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout


def init_repo(tempdir: Path) -> Path:
    repo = tempdir / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Autoreview Test")
    git(repo, "config", "user.email", "autoreview@example.invalid")
    return repo


def installed_java() -> str | None:
    java = shutil.which("java")
    if java is None:
        return None
    try:
        probe = subprocess.run(
            [java, "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return None
    return java if probe.returncode == 0 else None


def add_fake_trufflehog(
    helper: dict[str, object],
    root: Path,
    env: dict[str, str],
) -> None:
    write_executable(
        root / "trufflehog",
        "#!/usr/bin/env python3\nraise SystemExit(0)\n",
    )
    env["PATH"] = f"{root}{os.pathsep}{env.get('PATH', '')}"


def path_excluding_command(name: str) -> str:
    """Build a PATH value with every directory that resolves ``name``
    removed, so a subprocess launched with it cannot find that command
    even when it is genuinely installed on the host running the tests.
    """
    kept = []
    for part in os.environ.get("PATH", "").split(os.pathsep):
        if not part:
            continue
        if (Path(part) / name).is_file():
            continue
        kept.append(part)
    return os.pathsep.join(kept)


class AutoreviewHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.helper = load_helper()

    def test_outgoing_pack_scan_reads_exact_prompt_including_deleted_lines(self) -> None:
        prompt = (
            "# Change Bundle\n"
            "diff --git a/config.ts b/config.ts\n"
            "deleted file mode 100644\n"
            "--- a/config.ts\n"
            "+++ /dev/null\n"
            "@@ -1 +0,0 @@\n"
            "-const apiKey = \"removed-but-still-sensitive\";\n"
        )
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))

            def run_scanner(
                command: list[str],
                cwd: Path,
                **_kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                self.assertEqual(command[1], "filesystem")
                self.assertEqual(Path(command[2]).read_text(encoding="utf-8"), prompt)
                self.assertIn("-const apiKey", prompt)
                return subprocess.CompletedProcess(command, 0, "", "")

            with mock.patch.dict(
                self.helper["scan_outgoing_review_pack"].__globals__,
                {
                    "find_command": lambda _name, _repo: "/trusted/trufflehog",
                    "run": run_scanner,
                },
            ):
                self.helper["scan_outgoing_review_pack"](repo, prompt)

    def test_outgoing_pack_scan_refuses_and_names_deleted_file(self) -> None:
        prompt = (
            "# Change Bundle\n"
            "diff --git a/config.ts b/config.ts\n"
            "deleted file mode 100644\n"
            "--- a/config.ts\n"
            "+++ /dev/null\n"
            "@@ -1 +0,0 @@\n"
            "-const apiKey = \"removed-but-still-sensitive\";\n"
        )
        finding = {
            "SourceMetadata": {
                "Data": {
                    "Filesystem": {
                        "file": "review-pack.txt",
                        "line": 7,
                    }
                }
            },
            "Raw": "must-not-be-printed",
        }
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            with mock.patch.dict(
                self.helper["scan_outgoing_review_pack"].__globals__,
                {
                    "find_command": lambda _name, _repo: "/trusted/trufflehog",
                    "run": lambda command, _cwd, **_kwargs: subprocess.CompletedProcess(
                        command,
                        self.helper["TRUFFLEHOG_FINDINGS_EXIT_CODE"],
                        json.dumps(finding) + "\n",
                        "",
                    ),
                },
            ):
                with self.assertRaisesRegex(SystemExit, "config.ts") as error:
                    self.helper["scan_outgoing_review_pack"](repo, prompt)
        self.assertNotIn("must-not-be-printed", str(error.exception))

    def test_outgoing_pack_scan_fails_closed_when_scanner_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            with mock.patch.dict(
                self.helper["scan_outgoing_review_pack"].__globals__,
                {"find_command": lambda _name, _repo: None},
            ):
                with self.assertRaisesRegex(SystemExit, "refusing to send review pack"):
                    self.helper["scan_outgoing_review_pack"](repo, "prompt")

    def test_reviewer_scan_refusal_prevents_provider_call(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P0")
        provider = mock.Mock()
        with mock.patch.dict(
            self.helper["run_reviewer"].__globals__,
            {
                "scan_outgoing_review_pack": mock.Mock(
                    side_effect=SystemExit("refusing to send review pack: config.ts")
                ),
                "run_engine": provider,
            },
        ):
            with self.assertRaisesRegex(SystemExit, "config.ts"):
                self.helper["run_reviewer"](
                    args,
                    Path.cwd(),
                    "prompt",
                    set(),
                    [],
                )
        provider.assert_not_called()

    def test_local_bundle_preserves_boundary_when_sensitive_diff_is_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            path = repo / ".env"
            path.write_text("TOKEN=placeholder\n", encoding="utf-8")
            git(repo, "add", path.name)
            git(repo, "commit", "-q", "-m", "base")
            path.write_text("TOKEN=changed-placeholder\n", encoding="utf-8")
            git(repo, "add", path.name)

            bundle, truncated = self.helper["local_bundle"](repo)

            self.assertIn(self.helper["REVIEW_SECURITY_OMISSION"], bundle)
            self.assertFalse(truncated)

    def test_powershell_harness_exposes_runnable_engines_only(self) -> None:
        harness = SCRIPT.with_name("test-review-harness.ps1").read_text(encoding="utf-8")

        self.assertIn("[ValidateSet('codex', 'claude', 'amp', 'pi', 'kimi')]", harness)

    def test_local_bundle_omits_sensitive_untracked_file_without_blocking(self) -> None:
        for rel in (".env", "tokens/session.dat", "secrets/local.py"):
            with self.subTest(rel=rel), tempfile.TemporaryDirectory() as tempdir:
                repo = init_repo(Path(tempdir))
                path = repo / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("placeholder=true\n", encoding="utf-8")
                (repo / "review.py").write_text("print('review me')\n", encoding="utf-8")

                bundle, truncated = self.helper["local_bundle"](repo)

                self.assertIn("# Review Input Omissions", bundle)
                self.assertIn(self.helper["REVIEW_SECURITY_OMISSION"], bundle)
                self.assertNotIn(rel, bundle)
                self.assertNotIn("placeholder=true", bundle)
                self.assertIn("print('review me')", bundle)
                self.assertFalse(truncated)

    def test_local_bundle_marks_untracked_binary_input_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "image.bin").write_bytes(b"\x89PNG\r\n\0binary-content")

            bundle, truncated = self.helper["local_bundle"](repo)

            self.assertIn(
                '# Untracked File\npath: "image.bin"\n'
                'source-line 1: "[binary file omitted]"',
                bundle,
            )
            self.assertTrue(truncated)

    def test_local_bundle_rejects_non_utf8_untracked_text(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "latin.py").write_bytes(b"print('caf\xe9')\n")

            with self.assertRaisesRegex(SystemExit, "non-UTF-8 file"):
                self.helper["local_bundle"](repo)

    def test_local_bundle_uses_validated_untracked_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "notes.txt").write_text("review me\n", encoding="utf-8")
            original_read_prefix = self.helper["read_prefix"]
            reads = 0

            def read_once(path: Path, limit: int) -> tuple[bytes, bool]:
                nonlocal reads
                reads += 1
                if reads > 1:
                    raise AssertionError("untracked file was reopened after validation")
                return original_read_prefix(path, limit)

            with mock.patch.dict(
                self.helper["local_bundle"].__globals__,
                {"read_prefix": read_once},
            ):
                bundle, truncated = self.helper["local_bundle"](repo)

            expected_record = json.dumps("review me" + os.linesep)
            self.assertIn(
                '# Untracked File\npath: "notes.txt"\n'
                f"source-line 1: {expected_record}",
                bundle,
            )
            self.assertFalse(truncated)
            self.assertEqual(reads, 1)

    def test_tracked_binary_changes_are_blocked_in_all_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            binary = repo / "artifact.bin"
            binary.write_bytes(b"\0base")
            git(repo, "add", "artifact.bin")
            git(repo, "commit", "-q", "-m", "base")
            base = git(repo, "rev-parse", "HEAD").strip()

            binary.write_bytes(b"\0changed")
            git(repo, "add", "artifact.bin")
            with self.assertRaisesRegex(SystemExit, "refusing binary changes"):
                self.helper["local_bundle"](repo)

            git(repo, "commit", "-q", "-m", "binary change")
            with self.assertRaisesRegex(SystemExit, "refusing binary changes"):
                self.helper["commit_bundle"](repo, "HEAD")
            with self.assertRaisesRegex(SystemExit, "refusing binary changes"):
                self.helper["branch_bundle"](repo, base)

    def test_gitlink_changes_are_blocked_in_all_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            tracked = repo / "tracked.txt"
            tracked.write_text("base\n", encoding="utf-8")
            git(repo, "add", "tracked.txt")
            git(repo, "commit", "-q", "-m", "base")
            base = git(repo, "rev-parse", "HEAD").strip()

            git(
                repo,
                "update-index",
                "--add",
                "--cacheinfo",
                f"160000,{base},vendor/dependency",
            )
            with self.assertRaisesRegex(SystemExit, "gitlink/submodule changes"):
                self.helper["local_bundle"](repo)

            git(repo, "commit", "-q", "-m", "add gitlink")
            with self.assertRaisesRegex(SystemExit, "gitlink/submodule changes"):
                self.helper["commit_bundle"](repo, "HEAD")
            with self.assertRaisesRegex(SystemExit, "gitlink/submodule changes"):
                self.helper["branch_bundle"](repo, base)

    def test_gitlink_guard_parses_combined_raw_modes(self) -> None:
        raw_diff = (
            "::100644 100644 160000 "
            + ("a" * 40)
            + " "
            + ("b" * 40)
            + " "
            + ("c" * 40)
            + " MM\0vendor/dependency\0"
        )

        with self.assertRaisesRegex(SystemExit, "gitlink/submodule changes"):
            self.helper["require_no_gitlink_diff"]("merge diff", raw_diff)

    def test_codex_config_rejects_capability_bearing_overrides(self) -> None:
        for override in (
            'mcp_servers.review.command="touch /tmp/owned"',
            'notify=["sh", "-c", "touch /tmp/owned"]',
            'model_instructions_file="/tmp/hostile.md"',
            'model_provider="credential-sink"',
            'hooks.PreToolUse.command="touch /tmp/owned"',
        ):
            with self.subTest(override=override), self.assertRaisesRegex(
                SystemExit,
                "unsafe Codex config override refused",
            ):
                self.helper["codex_config_overrides"](
                    argparse.Namespace(codex_config=[override])
                )

    def test_codex_config_accepts_safe_tuning_overrides(self) -> None:
        args = argparse.Namespace(
            codex_config=[
                'service_tier="fast"',
                'model_verbosity="low"',
                'model_reasoning_summary="concise"',
            ]
        )

        self.assertEqual(
            self.helper["codex_config_overrides"](args),
            args.codex_config,
        )

    def test_untracked_files_respect_trusted_global_excludes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            home = root / "home"
            home.mkdir()
            excludes = root / "global-ignore"
            excludes.write_text(
                "ignored.local\n!settings.local\n",
                encoding="utf-8",
            )
            (home / ".gitconfig").write_text(
                f"[core]\n\texcludesFile = {excludes.as_posix()}\n",
                encoding="utf-8",
            )
            (repo / "ignored.local").write_text("private notes\n", encoding="utf-8")
            (repo / ".gitignore").write_text("settings.local\n", encoding="utf-8")
            (repo / "settings.local").write_text("repo private\n", encoding="utf-8")
            git(repo, "add", ".gitignore")
            (repo / "visible.txt").write_text("review me\n", encoding="utf-8")
            (repo / "hostile-gitconfig").write_text(
                "[core]\n\texcludesFile = /does/not/exist\n",
                encoding="utf-8",
            )

            with mock.patch.dict(
                os.environ,
                {
                    "HOME": str(home),
                    "USERPROFILE": str(home),
                    "GIT_CONFIG_GLOBAL": str(repo / "hostile-gitconfig"),
                },
            ):
                self.assertEqual(
                    self.helper["safe_untracked_files"](repo),
                    ["hostile-gitconfig", "visible.txt"],
                )

    def test_dirty_check_respects_trusted_global_excludes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            home = root / "home"
            home.mkdir()
            excludes = root / "global-ignore"
            excludes.write_text("ignored.local\n", encoding="utf-8")
            (home / ".gitconfig").write_text(
                f"[core]\n\texcludesFile = {excludes.as_posix()}\n",
                encoding="utf-8",
            )
            (repo / "ignored.local").write_text("private notes\n", encoding="utf-8")

            with mock.patch.dict(
                os.environ,
                {
                    "HOME": str(home),
                    "USERPROFILE": str(home),
                },
            ):
                self.assertFalse(self.helper["is_dirty"](repo))

    def test_oversized_text_is_rejected_without_scanning_binary_tail(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            detector_tail = "\ntoken=" + "A" * 24 + "\n"
            content = "x" * (64_000 * 3 - 4) + detector_tail

            untracked = repo / "untracked.txt"
            untracked.write_text(content, encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "file too large to scan safely"):
                self.helper["safe_untracked_files"](repo)

            untracked.unlink()
            binary = repo / "binary.bin"
            binary.write_bytes(b"\0" + content.encode())
            self.assertEqual(
                self.helper["safe_untracked_files"](repo),
                ["binary.bin"],
            )

            binary.unlink()
            evidence = repo / "evidence.txt"
            evidence.write_text(content, encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "file too large to scan safely"):
                self.helper["validate_evidence_file"](repo, "evidence.txt", "--dataset")

    def test_branch_bundle_rejects_unsafe_or_unknown_base_before_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "tracked.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "tracked.txt")
            git(repo, "commit", "-q", "-m", "base")

            with self.assertRaisesRegex(SystemExit, "unsafe base ref"):
                self.helper["branch_bundle"](repo, "--help")
            with self.assertRaisesRegex(SystemExit, "unknown base ref"):
                self.helper["branch_bundle"](repo, "origin/main")

    def test_commit_bundle_rejects_merge_commits(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "base.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "base.txt")
            git(repo, "commit", "-q", "-m", "base")
            base_branch = git(repo, "branch", "--show-current").strip()
            git(repo, "checkout", "-q", "-b", "side")
            (repo / "side.txt").write_text("side\n", encoding="utf-8")
            git(repo, "add", "side.txt")
            git(repo, "commit", "-q", "-m", "side")
            git(repo, "checkout", "-q", base_branch)
            (repo / "main.txt").write_text("main\n", encoding="utf-8")
            git(repo, "add", "main.txt")
            git(repo, "commit", "-q", "-m", "main")
            git(repo, "merge", "-q", "--no-ff", "side", "-m", "merge")

            with self.assertRaisesRegex(SystemExit, "does not accept merge commits"):
                self.helper["commit_bundle"](repo, "HEAD")

    def test_git_path_list_preserves_newline_filenames(self) -> None:
        if os.name == "nt":
            self.skipTest("Windows filesystems do not support newline path components")
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            rel = "line\nbreak.txt"
            (repo / rel).write_text("content\n", encoding="utf-8")
            git(repo, "add", rel)

            paths = self.helper["git_path_list"](repo, "ls-files", "-z")

            self.assertIn(rel, paths)

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires raw non-UTF-8 filename support")
    def test_git_path_list_rejects_non_utf8_output(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            rel = os.fsdecode(b"invalid-\xff.txt")
            (repo / rel).write_text("content\n", encoding="utf-8")
            git(repo, "add", "--", rel)

            with self.assertRaisesRegex(SystemExit, "non-UTF-8 Git output"):
                self.helper["git_path_list"](repo, "ls-files", "-z")

    def test_review_patch_rejects_oversized_content(self) -> None:
        with self.assertRaisesRegex(SystemExit, "too large to review safely"):
            self.helper["validate_review_patch"]("local staged diff", ["safe.txt"], "x" * 25, 10)

    def test_review_patch_limit_counts_utf8_bytes(self) -> None:
        with self.assertRaisesRegex(SystemExit, r"12 bytes; limit 10"):
            self.helper["validate_review_patch"]("local staged diff", ["safe.txt"], "界" * 4, 10)

    def test_review_patch_accepts_large_content_without_explicit_limit(self) -> None:
        patch = (
            "diff --git a/safe.txt b/safe.txt\n"
            "--- a/safe.txt\n"
            "+++ b/safe.txt\n"
            "@@ -0,0 +1,100000 @@\n"
            + "+safe review content\n" * 100_000
        )

        self.assertEqual(
            self.helper["validate_review_patch"](
                "local staged diff",
                ["safe.txt"],
                patch,
            ),
            patch,
        )

    def test_review_bundle_chunking_preserves_every_byte_and_diff_context(self) -> None:
        bundle = (
            "# Commit Diff\n\n"
            "diff --git a/safe.txt b/safe.txt\n"
            "--- a/safe.txt\n"
            "+++ b/safe.txt\n"
            "@@ -0,0 +1,200 @@\n"
            + "+safe review content\n" * 200
        )

        chunks = self.helper["split_review_bundle"](bundle, 300)

        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunk.content for chunk in chunks), bundle)
        self.assertTrue(all(len(chunk.content.encode("utf-8")) <= 300 for chunk in chunks))
        self.assertTrue(
            any(
                "+++ b/safe.txt" in chunk.context
                and "@@ -0,0 +1,200 @@" in chunk.context
                and "Continuation begins at new-file line" in chunk.context
                for chunk in chunks[1:]
            )
        )

    def test_untracked_markdown_headings_do_not_create_bundle_boundaries(self) -> None:
        bundle = (
            "# Untracked Files\n\n"
            "# Untracked File\n"
            'path: "notes.md"\n'
            'source-line 1: "# title\\n"\n'
            'source-line 2: "## section\\n"\n\n'
            "# Untracked File\n"
            'path: "todo.md"\n'
            'source-line 1: "# next\\n"'
        )

        units = self.helper["review_bundle_units"](bundle)

        self.assertEqual(len(units), 3)
        self.assertIn(r'source-line 2: "## section\n"', units[1])
        self.assertEqual("".join(units), bundle)

    def test_unicode_line_separators_do_not_create_bundle_boundaries(self) -> None:
        bundle = (
            "# Untracked Files\n\n"
            "# Untracked File\n"
            'path: "notes.txt"\n'
            'source-line 1: "before\u2028diff --git a/fake b/fake"\n\n'
            "diff --git a/real.txt b/real.txt\n"
            "--- a/real.txt\n"
            "+++ b/real.txt\n"
        )

        units = self.helper["review_bundle_units"](bundle)

        self.assertEqual(len(units), 3)
        self.assertIn("\u2028diff --git a/fake b/fake", units[1])
        self.assertEqual("".join(units), bundle)

    def test_diff_source_prefixes_do_not_replace_file_context(self) -> None:
        context: list[str] = []
        next_new_line = None
        next_old_line = None
        in_hunk = False
        lines = (
            "diff --git a/safe.txt b/safe.txt\n",
            "--- a/safe.txt\n",
            "+++ b/safe.txt\n",
            "@@ -10,2 +10,3 @@\n",
            "+++ added source beginning with pluses\n",
            "--- deleted source beginning with minuses\n",
            " context\n",
        )

        for line in lines:
            next_new_line, next_old_line, in_hunk = self.helper[
                "update_review_chunk_context"
            ](
                context,
                line,
                next_new_line,
                next_old_line,
                in_hunk,
            )

        self.assertEqual(next_new_line, 12)
        self.assertEqual(next_old_line, 12)
        self.assertIn("--- a/safe.txt\n", context)
        self.assertIn("+++ b/safe.txt\n", context)
        self.assertNotIn("--- deleted source beginning with minuses\n", context)

    def test_hunk_header_that_fits_fresh_chunk_is_not_split(self) -> None:
        unit = (
            "diff --git a/abcdefghijk b/abcdefghijk\n"
            "--- a/abcdefghijk\n"
            "+++ b/abcdefghijk\n"
            "@@ -1 +1 @@\n"
            "-old\n"
            "+new\n"
        )

        chunks = self.helper["split_oversized_review_unit"](unit, 85)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(any("@@ -1 +1 @@\n" in chunk.content for chunk in chunks))
        self.assertEqual("".join(chunk.content for chunk in chunks), unit)

    def test_long_diff_line_continuations_keep_their_original_marker(self) -> None:
        for marker in ("+", "-", " "):
            with self.subTest(marker=marker):
                unit = (
                    "diff --git a/large.txt b/large.txt\n"
                    "--- a/large.txt\n"
                    "+++ b/large.txt\n"
                    "@@ -1 +1 @@\n"
                    f"{marker}{'x' * 400}\n"
                )

                chunks = self.helper["split_oversized_review_unit"](unit, 140)

                self.assertTrue(
                    any(
                        f"original marker is `{marker}`" in chunk.context
                        for chunk in chunks[1:]
                    )
                )
                self.assertEqual("".join(chunk.content for chunk in chunks), unit)

    def test_multiple_long_line_tails_pack_into_following_chunks(self) -> None:
        limit = 200
        unit = (
            "diff --git a/large.txt b/large.txt\n"
            "--- a/large.txt\n"
            "+++ b/large.txt\n"
            "@@ -1,5 +1,5 @@\n"
            + ("+" + "x" * 205 + "\n") * 5
        )

        chunks = self.helper["split_oversized_review_unit"](unit, limit)
        minimum_chunks = (len(unit.encode("utf-8")) + limit - 1) // limit

        self.assertLessEqual(len(chunks), minimum_chunks + 1)
        self.assertEqual("".join(chunk.content for chunk in chunks), unit)
        self.assertTrue(all(len(chunk.content.encode("utf-8")) <= limit for chunk in chunks))

    def test_untracked_continuation_context_keeps_source_line(self) -> None:
        unit = (
            "# Untracked File\n"
            'path: "notes.txt"\n'
            'source-line 1: "short\\n"\n'
            f'source-line 2: "{"x" * 300}"\n'
        )

        chunks = self.helper["split_oversized_review_unit"](unit, 120)

        self.assertGreater(len(chunks), 2)
        self.assertTrue(
            any(
                "Continuation begins at untracked source line 2" in chunk.context
                for chunk in chunks[1:]
            )
        )
        self.assertEqual("".join(chunk.content for chunk in chunks), unit)

    def test_deleted_file_continuation_uses_positive_old_line(self) -> None:
        unit = (
            "diff --git a/removed.txt b/removed.txt\n"
            "--- a/removed.txt\n"
            "+++ /dev/null\n"
            "@@ -40,50 +0,0 @@\n"
            + "-deleted content\n" * 50
        )

        chunks = self.helper["split_oversized_review_unit"](unit, 180)

        deletion_contexts = [
            chunk.context for chunk in chunks[1:] if "old-file line" in chunk.context
        ]
        self.assertTrue(deletion_contexts)
        self.assertTrue(all("line 0" not in context for context in deletion_contexts))
        self.assertTrue(all("--- a/removed.txt" in context for context in deletion_contexts))

    def test_long_complete_context_is_retained_or_rejected(self) -> None:
        path = "nested/" + "x" * 10_000 + ".txt"
        context = [
            f'diff --git "a/{path}" "b/{path}"\n',
            f'--- "a/{path}"\n',
            f'+++ "b/{path}"\n',
            "@@ -1 +1 @@\n",
        ]

        rendered = self.helper["review_chunk_context"](context, 2, 2)

        self.assertIn(f'+++ "b/{path}"', rendered)
        self.assertIn("@@ -1 +1 @@", rendered)
        self.assertIn("Continuation begins at new-file line 2", rendered)

    def test_review_bundle_packs_oversized_unit_tails_globally(self) -> None:
        limit = 1_000
        units = []
        for index in range(5):
            header = (
                f"diff --git a/file-{index}.txt b/file-{index}.txt\n"
                f"--- a/file-{index}.txt\n"
                f"+++ b/file-{index}.txt\n"
                "@@ -0,0 +1 @@\n"
            )
            body = "+" + "x" * (1_100 - len(header.encode("utf-8")) - 2) + "\n"
            units.append(header + body)
        bundle = "".join(units)

        chunks = self.helper["split_review_bundle"](bundle, limit)

        self.assertEqual(len(chunks), 6)
        self.assertEqual("".join(chunk.content for chunk in chunks), bundle)
        self.assertTrue(all(len(chunk.content.encode("utf-8")) <= limit for chunk in chunks))

    def test_large_bundle_stays_single_pass_until_prompt_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            prompts = self.helper["build_review_prompts"](
                repo,
                "commit",
                "HEAD",
                "# Commit Diff\n" + "safe review content\n" * 18_000,
                "",
                "",
            )

        self.assertEqual(len(prompts), 1)

    def test_bundle_above_prompt_limit_uses_complete_bounded_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            prompts = self.helper["build_review_prompts"](
                repo,
                "commit",
                "HEAD",
                "# Commit Diff\n" + "safe review content\n" * 35_000,
                "",
                "",
            )

        self.assertGreater(len(prompts), 1)
        self.assertTrue(
            all(
                len(prompt.encode("utf-8"))
                <= self.helper["MAX_REVIEW_PROMPT_BYTES"]
                for prompt in prompts
            )
        )
        self.assertTrue(all("Oversized review bundle chunk:" in prompt for prompt in prompts))

    def test_kimi_prompt_budget_partitions_before_argv_limits(self) -> None:
        if os.name == "nt":
            self.skipTest("the 30 KiB Windows argv budget cannot fit the chunk-context reservation")
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            prompts = self.helper["build_review_prompts"](
                repo,
                "commit",
                "HEAD",
                "# Commit Diff\n" + "safe review content\n" * 12_000,
                "",
                "",
                self.helper["KIMI_MAX_PROMPT_BYTES"],
            )

        self.assertGreater(len(prompts), 1)
        self.assertTrue(
            all(
                len(prompt.encode("utf-8")) <= self.helper["KIMI_MAX_PROMPT_BYTES"]
                for prompt in prompts
            )
        )

    def test_review_prompt_preserves_bundle_ending_whitespace(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            bundle = "# Commit Diff\n+Markdown hard break  \n+\n"
            prompt = self.helper["render_review_prompt"](
                repo,
                "commit",
                "HEAD",
                self.helper["ReviewChunk"](bundle),
                "",
                "",
            )

        self.assertTrue(prompt.endswith(bundle))

    def test_review_pass_count_is_bounded(self) -> None:
        builder = self.helper["build_review_prompts"]
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            with mock.patch.dict(builder.__globals__, {"MAX_REVIEW_PASSES": 1}):
                with self.assertRaisesRegex(SystemExit, "more than 1 bounded passes"):
                    builder(
                        repo,
                        "commit",
                        "HEAD",
                        "# Commit Diff\n" + "safe review content\n" * 35_000,
                        "",
                        "",
                    )

    def test_review_patch_does_not_disclose_controls_in_omitted_paths(self) -> None:
        path = ".env.\x1b]52;c;VEVTVA==\x07\udc9b"

        redacted = self.helper["validate_review_patch"](
            "local staged diff",
            [path],
            "",
        )

        self.assertEqual(
            redacted,
            self.helper["REVIEW_SECURITY_OMISSION"] + "\n",
        )
        self.assertNotIn("\x1b", redacted)
        self.assertNotIn("\x07", redacted)
        self.assertNotIn("\udc9b", redacted)

    def test_review_patch_omits_everything_when_sensitive_paths_cannot_be_mapped(
        self,
    ) -> None:
        patch = (
            "commit metadata that must not survive a mapping failure\n"
            "diff --cc .env\n"
            "@@@ -1,1 -1,1 +1,1 @@@\n"
            "++placeholder=true\n"
        )

        redacted = self.helper["validate_review_patch"](
            "branch diff",
            [".env"],
            patch,
        )

        self.assertEqual(
            redacted,
            self.helper["REVIEW_SECURITY_OMISSION"] + "\n",
        )
        self.assertNotIn("placeholder", redacted)
        self.assertNotIn("commit metadata", redacted)

    def test_review_patch_preserves_combined_and_headerless_hunk_content(self) -> None:
        credential_shaped_code = '+token = "ordinary-hardcoded-value-12345"\n'
        for patch in (
            "@@ -0,0 +1 @@\n" + credential_shaped_code,
            "diff --cc src/runtime.ts\n"
            "@@@ -0,0 -0,0 +1 @@@\n"
            "++token = \"ordinary-hardcoded-value-12345\"\n",
        ):
            with self.subTest(patch=patch):
                validated = self.helper["validate_review_patch"](
                    "commit diff",
                    ["src/runtime.ts"],
                    patch,
                )
                self.assertIn("ordinary-hardcoded-value-12345", validated)

    def test_tracked_sensitive_paths_are_omitted_in_all_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "base.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "base.txt")
            git(repo, "commit", "-q", "-m", "base")
            base = git(repo, "rev-parse", "HEAD").strip()

            (repo / ".env").write_text("placeholder=true\n", encoding="utf-8")
            (repo / "base.txt").write_text("base\nreview me\n", encoding="utf-8")
            git(repo, "add", ".env", "base.txt")
            local, local_truncated = self.helper["local_bundle"](repo)
            self.assertIn(self.helper["REVIEW_SECURITY_OMISSION"], local)
            self.assertNotIn(".env", local)
            self.assertNotIn("placeholder=true", local)
            self.assertIn("+review me", local)
            self.assertFalse(local_truncated)

            git(repo, "commit", "-q", "-m", "sensitive path")
            for bundle, truncated in (
                self.helper["branch_bundle"](repo, base),
                self.helper["commit_bundle"](repo, "HEAD"),
            ):
                self.assertIn(self.helper["REVIEW_SECURITY_OMISSION"], bundle)
                self.assertNotIn(".env", bundle)
                self.assertNotIn("placeholder=true", bundle)
                self.assertIn("+review me", bundle)
                self.assertFalse(truncated)

    def test_secret_named_workflows_are_reviewable_in_all_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "base.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "base.txt")
            git(repo, "commit", "-q", "-m", "base")
            base = git(repo, "rev-parse", "HEAD").strip()

            workflow = repo / ".github" / "workflows" / "secret-scan.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("name: Secret scan\n", encoding="utf-8")
            untracked_bundle, _ = self.helper["local_bundle"](repo)
            self.assertIn("secret-scan.yml", untracked_bundle)

            git(repo, "add", str(workflow.relative_to(repo)))
            tracked_bundle, _ = self.helper["local_bundle"](repo)
            self.assertIn("secret-scan.yml", tracked_bundle)

            git(repo, "commit", "-q", "-m", "add secret scanner")
            branch_bundle, _ = self.helper["branch_bundle"](repo, base)
            commit_bundle, _ = self.helper["commit_bundle"](repo, "HEAD")
            self.assertIn("secret-scan.yml", branch_bundle)
            self.assertIn("secret-scan.yml", commit_bundle)

    def test_case_variant_secret_named_workflows_remain_sensitive(self) -> None:
        for rel in (
            ".GitHub/workflows/secret-scan.yml",
            ".github/Workflows/secret-scan.yml",
            ".github/workflows/secret-scan.YML",
        ):
            with self.subTest(rel=rel):
                self.assertIsNotNone(self.helper["sensitive_repo_path_risk"](rel))
                self.assertIsNotNone(
                    self.helper["tracked_sensitive_repo_path_risk"](rel)
                )

    def test_tracked_source_names_and_env_templates_remain_reviewable(self) -> None:
        for rel in (
            "tokenizer.py",
            "token_count.ts",
            "src/token/parser.py",
            "src/token/session.ts",
            "internal/tokens/types.go",
            "packages/token/package.json",
            "scripts/tokens/session.sh",
            "src/tokens/session.mjs",
            "credentials/prod.py",
            "secrets/runtime.ts",
            "src/credentials/provider.py",
            "src/secrets/scanner.ts",
            "ui/tokens/session.vue",
            "proto/token/session.proto",
            "password_validator.go",
            ".env.example",
            "private/parser.py",
            ".agents/skills/openclaw-secret-scanning-maintainer/SKILL.md",
            "design-tokens/colors.json",
            "design-tokens.json",
            "design_tokens.json",
            "tokens/default.json",
            "token_count/generated.py",
            ".docker/Dockerfile",
            ".docker/scripts/build.sh",
            ".github/workflows/secret-scan.yml",
        ):
            with self.subTest(rel=rel):
                self.assertIsNone(self.helper["tracked_sensitive_repo_path_risk"](rel))

    def test_untracked_token_source_paths_remain_reviewable(self) -> None:
        for rel in (
            "src/token/parser.py",
            "src/token/session.ts",
            "scripts/tokens/session.sh",
            "src/tokens/session.mjs",
            "ui/tokens/session.vue",
            "proto/token/session.proto",
        ):
            with self.subTest(rel=rel):
                self.assertIsNone(self.helper["sensitive_repo_path_risk"](rel))

    def test_untracked_credential_shaped_source_content_is_reviewed(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            source = 'const token = "ordinary-hardcoded-value-12345";\n'
            path = repo / "src" / "runtime.ts"
            path.parent.mkdir()
            path.write_text(source, encoding="utf-8")

            bundle, truncated = self.helper["local_bundle"](repo)

            self.assertIn("ordinary-hardcoded-value-12345", bundle)
            self.assertFalse(truncated)

    def test_untracked_design_token_artifacts_remain_reviewable(self) -> None:
        for rel in (
            "design-tokens.json",
            "design_tokens.json",
            "src/styles/design-tokens.json",
            "themes/dark/design_tokens.json",
            "tokens/design-tokens.json",
            "tokens/design_tokens.json",
        ):
            with self.subTest(rel=rel):
                self.assertIsNone(self.helper["sensitive_repo_path_risk"](rel))
                self.assertIsNone(
                    self.helper["tracked_sensitive_repo_path_risk"](rel)
                )
        self.assertIsNotNone(
            self.helper["sensitive_repo_path_risk"](".env/design-tokens.json")
        )
        self.assertIsNotNone(
            self.helper["tracked_sensitive_repo_path_risk"](
                ".env/design-tokens.json"
            )
        )
        self.assertIsNotNone(
            self.helper["tracked_sensitive_repo_path_risk"](
                ".env/tokens/design-tokens.json"
            )
        )

    def test_sensitive_named_source_directories_are_blocked_untracked(self) -> None:
        for rel in (
            "credentials/prod.py",
            "secrets/runtime.ts",
            "src/credentials/provider.py",
            "src/secrets/scanner.ts",
        ):
            with self.subTest(rel=rel):
                self.assertIsNotNone(self.helper["sensitive_repo_path_risk"](rel))

    def test_tracked_env_variants_remain_sensitive(self) -> None:
        for rel in (
            ".env-local",
            ".env_prod",
            ".env/production",
            ".env/example/production",
            ".env/template/prod",
        ):
            with self.subTest(rel=rel):
                self.assertIsNotNone(
                    self.helper["tracked_sensitive_repo_path_risk"](rel)
                )

    def test_suffixed_credential_data_paths_remain_sensitive(self) -> None:
        for rel in (
            "credentials-prod.json",
            "service-account-dev.yaml",
            "api-key.backup.json",
            "token-prod.json",
            "tokens.json",
            "auth-token.yaml",
            "prod-credentials.json",
            "google-service-account.json",
            "client-secret.yaml",
            "credentials/prod.json",
            "prod-credentials/client.conf",
            "client-secrets/account.ini",
            "token/production.json",
            "tokens/production.json",
            "tokens/session.dat",
            "tokens/cache.json",
            "token/user.json",
            "tokens/device.sqlite",
            "tokens/session.jwt",
            "tokens/session",
            "backup-secrets/prod.json",
            "dev_credentials/runtime.yaml",
            "client-secrets-old/account.ini",
            "client-secrets/account.properties",
            "credentials/prod.xml",
            "secrets/prod.md",
            "credentials.txt",
            "client-secret.csv",
            ".docker/config.json",
            "deployment/.docker/config.json",
            ".netrc",
            "config/.netrc",
            ".git-credentials",
            "config/.git-credentials",
        ):
            with self.subTest(rel=rel):
                self.assertIsNotNone(
                    self.helper["tracked_sensitive_repo_path_risk"](rel)
                )

    def test_review_patch_allows_provider_references_and_test_placeholders(
        self,
    ) -> None:
        token_name = "to" + "ken"
        key_name = "api_" + "key"
        secret_name = "api_" + "secret"
        safe_patch = (
            "diff --git a/provider.ts b/provider.ts\n"
            "--- a/provider.ts\n"
            "+++ b/provider.ts\n"
            "@@ -1 +1,6 @@\n"
            f"-const {token_name} = data.session?.access_token;\n"
            f"+const {token_name} = data.session?.access_token;\n"
            "+const api" + f"Key = providerConfig.{key_name};\n"
            "+const api" + "Sec" + f"ret = providerConfig.{secret_name};\n"
            f'+const fixture = {{ {key_name}: "test-key" }};\n'
            f'+const fixtureSecret = {{ {secret_name}: "test-secret" }};\n'
            f'+const session = {{ access_{token_name}: "test-token" }};\n'
        )

        self.assertEqual(
            self.helper["validate_review_patch"](
                "branch diff",
                ["provider.ts"],
                safe_patch,
            ),
            safe_patch,
        )

    def test_secret_detector_allows_typescript_credential_plumbing_fixture(self) -> None:
        source = (FIXTURES / "typescript-benign-references.ts").read_text(
            encoding="utf-8"
        )

        patch = (
            "diff --git a/src/credential-plumbing.ts b/src/credential-plumbing.ts\n"
            "new file mode 100644\n"
            "--- /dev/null\n"
            "+++ b/src/credential-plumbing.ts\n"
            f"@@ -0,0 +1,{len(source.splitlines())} @@\n"
            + "".join(f"+{line}\n" for line in source.splitlines())
        )
        validated = self.helper["validate_review_patch"](
            "typescript credential plumbing fixture",
            ["src/credential-plumbing.ts"],
            patch,
        )
        for reference in (
            "filePassword",
            "passwordResolution.password",
            "tokenResolution.token",
            "CredentialUnavailableDiagnostic",
            "tokenRef",
            "keyRef",
        ):
            self.assertIn(reference, validated)

    def test_review_bundle_preserves_deleted_swift_status_literals(self) -> None:
        # Regression: a deleted Swift file with status-string cases like
        # `case "ok-empty", "ok-token":` next to value returns is not a
        # credential. The retired heuristic scanner flagged the "ok-token"
        # key shape as secret-like even after value redaction, so the whole
        # deletion became unreviewable; the bundle must stay byte-identical.
        source = (FIXTURES / "swift-benign-status-literals.swift").read_text(
            encoding="utf-8"
        )
        patch = (
            "diff --git a/apps/macos/MenuContentView.swift "
            "b/apps/macos/MenuContentView.swift\n"
            "deleted file mode 100644\n"
            "--- a/apps/macos/MenuContentView.swift\n"
            "+++ /dev/null\n"
            f"@@ -1,{len(source.splitlines())} +0,0 @@\n"
            + "".join(f"-{line}\n" for line in source.splitlines())
        )

        self.assertEqual(
            self.helper["validate_review_patch"](
                "branch diff",
                ["apps/macos/MenuContentView.swift"],
                patch,
            ),
            patch,
        )

    @unittest.skipUnless(
        shutil.which("trufflehog"), "TruffleHog binary not installed"
    )
    def test_outgoing_pack_scan_accepts_deleted_swift_status_literals(self) -> None:
        # Live-scanner companion to the regression above: TruffleHog must not
        # flag the benign "ok-token" status literal in a deleted-file bundle.
        source = (FIXTURES / "swift-benign-status-literals.swift").read_text(
            encoding="utf-8"
        )
        prompt = (
            "# Change Bundle\n"
            "diff --git a/apps/macos/MenuContentView.swift "
            "b/apps/macos/MenuContentView.swift\n"
            "deleted file mode 100644\n"
            "--- a/apps/macos/MenuContentView.swift\n"
            "+++ /dev/null\n"
            f"@@ -1,{len(source.splitlines())} +0,0 @@\n"
            + "".join(f"-{line}\n" for line in source.splitlines())
        )
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            self.helper["scan_outgoing_review_pack"](repo, prompt)

    def test_review_bundle_preserves_typescript_config_paths(self) -> None:
        source = (FIXTURES / "typescript-benign-config-path-references.ts").read_text(
            encoding="utf-8"
        )
        patch = (
            "diff --git a/src/config-path-references.ts b/src/config-path-references.ts\n"
            "new file mode 100644\n"
            "--- /dev/null\n"
            "+++ b/src/config-path-references.ts\n"
            f"@@ -0,0 +1,{len(source.splitlines())} @@\n"
            + "".join(f"+{line}\n" for line in source.splitlines())
        )

        validated = self.helper["validate_review_patch"](
            "typescript config path references",
            ["src/config-path-references.ts"],
            patch,
        )

        for config_path in (
            "channels.irc.accounts.${accountId}.passwordFile",
            "channels.irc.accounts.${accountId}.nickserv.passwordFile",
            "channels.nextcloud-talk.accounts.${accountId}.botSecret",
            "channels.nextcloud-talk.accounts.${accountId}.botSecretFile",
            "channels.telegram.accounts.${accountId}.tokenFile",
        ):
            self.assertIn(config_path, validated)

        token_term = "To" + "ken"
        truncated_call_patch = (
            "diff --git a/src/token.ts b/src/token.ts\n"
            "--- a/src/token.ts\n"
            "+++ b/src/token.ts\n"
            "@@ -40,3 +40,4 @@ function resolveAccountToken() {\n"
            f"+  const account{token_term} = resolveRuntime{token_term}Value({{\n"
            "+    value: accountConfig.token,\n"
            "@@ -70,3 +71,4 @@ function resolveConfigToken() {\n"
            f"+  const config{token_term} = resolveRuntime{token_term}Value({{\n"
            "+    value: merged.token,\n"
        )
        self.assertEqual(
            self.helper["validate_review_patch"](
                "typescript truncated credential calls fixture",
                ["src/token.ts"],
                truncated_call_patch,
            ),
            truncated_call_patch,
        )

    def test_review_patch_preserves_safe_uri_userinfo(self) -> None:
        safe_lines = (
            'url = f"ssh://{ssh_user}@git.example.invalid/org/repo.git"',
            'url = "https://alice@github.com/example/repo"',
            'url = "https://username:@host/repo"',
            'remote = "ssh://git@github.com/org/repo.git"',
        )
        for line in safe_lines:
            with self.subTest(line=line):
                patch = (
                    "diff --git a/fixture.py b/fixture.py\n"
                    "--- a/fixture.py\n"
                    "+++ b/fixture.py\n"
                    "@@ -0,0 +1 @@\n"
                    f"+{line}\n"
                )

                validated = self.helper["validate_review_patch"](
                    "local unstaged diff",
                    ["fixture.py"],
                    patch,
                )

                self.assertIn(f"+{line}", validated)
                self.assertNotIn("redacted@", validated)

    def test_branch_bundle_preserves_deleted_jinja_pem_marker_regex(self) -> None:
        # Generic template regex delimiters are not private-key material. The
        # branch boundary must keep a deleted template reviewable as-is.
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            template = repo / "origin-pem.j2"
            template.write_text(
                "-----BEGIN [A-Z ]+-----\n"
                "{{ _body }}\n"
                "-----END [A-Z ]+-----\n",
                encoding="utf-8",
            )
            git(repo, "add", template.name)
            git(repo, "commit", "-q", "-m", "add template")
            base = git(repo, "rev-parse", "HEAD").strip()

            template.unlink()
            git(repo, "add", "-u")
            git(repo, "commit", "-q", "-m", "delete template")

            bundle, truncated = self.helper["branch_bundle"](repo, base)

            self.assertIn("deleted file mode 100644", bundle)
            self.assertIn("------BEGIN [A-Z ]+-----", bundle)
            self.assertIn("-{{ _body }}", bundle)
            self.assertIn("------END [A-Z ]+-----", bundle)
            self.assertFalse(truncated)

    def test_review_patch_preserves_redaction_placeholder_fallback(self) -> None:
        patch = (
            "diff --git a/runtime.py b/runtime.py\n"
            "--- a/runtime.py\n"
            "+++ b/runtime.py\n"
            "@@ -0,0 +1 @@\n"
            + "+pass"
            + 'word = getenv("PASSWORD") or "redacted"\n'
        )

        self.assertEqual(
            self.helper["validate_review_patch"](
                "local unstaged diff",
                ["runtime.py"],
                patch,
            ),
            patch,
        )

    def test_review_patch_preserves_ambiguous_short_markerless_lines(self) -> None:
        chunks = ["AB12", "CDef", "GH34", "ijKL", "MN56", "opQR"]
        patch = (
            "diff --git a/fixture.txt b/fixture.txt\n"
            "--- a/fixture.txt\n"
            "+++ b/fixture.txt\n"
            f"@@ -0,0 +1,{len(chunks)} @@\n"
            + "".join(f"+{chunk}\n" for chunk in chunks)
        )

        redacted_patch = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["fixture.txt"],
            patch,
        )

        self.assertEqual(redacted_patch, patch)

    def test_review_patch_preserves_long_non_pem_identifier_lines(self) -> None:
        identifier = "runDangerousOperationWithLongIdentifier"
        patch = (
            "diff --git a/runtime.ts b/runtime.ts\n"
            "--- a/runtime.ts\n"
            "+++ b/runtime.ts\n"
            "@@ -0,0 +1 @@\n"
            + f"+{identifier}\n"
        )

        redacted = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["runtime.ts"],
            patch,
        )

        self.assertIn("+" + identifier, redacted)

    def test_review_patch_preserves_hash_and_submodule_lines(self) -> None:
        digest = "abcdef0123456789abcdef0123456789abcdef01"
        patch = (
            "diff --git a/vendor b/vendor\n"
            "--- a/vendor\n"
            "+++ b/vendor\n"
            "@@ -1 +1,2 @@\n"
            + f"+{digest}\n"
            + f"+Subproject commit {digest}\n"
        )

        redacted = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["vendor"],
            patch,
        )

        self.assertIn("+" + digest, redacted)
        self.assertIn("+Subproject commit " + digest, redacted)

    def test_review_patch_preserves_unwrapped_alphabetic_identifier(self) -> None:
        identifier = "AbCdEfGh" + "IjKlMnOp"
        patch = (
            "diff --git a/runtime.ts b/runtime.ts\n"
            "--- a/runtime.ts\n"
            "+++ b/runtime.ts\n"
            "@@ -0,0 +1 @@\n"
            + f"+const {identifier} = true;\n"
        )

        redacted_patch = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["runtime.ts"],
            patch,
        )

        self.assertIn(identifier, redacted_patch)

    def test_review_patch_preserves_punctuation_wrapped_alphabetic_identifier(self) -> None:
        identifier = "AbCdEfGh" + "IjKlMnOp"
        patch = (
            "diff --git a/runtime.ts b/runtime.ts\n"
            "--- a/runtime.ts\n"
            "+++ b/runtime.ts\n"
            "@@ -0,0 +1 @@\n"
            + f"+  {identifier},\n"
        )

        redacted_patch = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["runtime.ts"],
            patch,
        )

        self.assertIn(identifier, redacted_patch)

    def test_review_patch_preserves_escaped_newline_beside_alphabetic_identifier(self) -> None:
        identifier = "AbCdEfGh" + "IjKlMnOp"
        patch = (
            "diff --git a/runtime.ts b/runtime.ts\n"
            "--- a/runtime.ts\n"
            "+++ b/runtime.ts\n"
            "@@ -0,0 +1 @@\n"
            + f'+[{identifier}, "\\\\n"];\n'
        )

        redacted_patch = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["runtime.ts"],
            patch,
        )

        self.assertIn(identifier, redacted_patch)

    def test_review_patch_preserves_bare_identifier_in_escaped_pem_concatenation(self) -> None:
        identifier = "AbCdEfGh" + "IjKlMnOp"
        patch = (
            "diff --git a/runtime.ts b/runtime.ts\n"
            "--- a/runtime.ts\n"
            "+++ b/runtime.ts\n"
            "@@ -0,0 +1 @@\n"
            '+const fixture = "-----BEGIN '
            + "PRIVATE KEY-----\\n\" + "
            + identifier
            + ' + "\\n-----END '
            + 'PRIVATE KEY-----";\n'
        )

        redacted_patch = self.helper["validate_review_patch"](
            "local unstaged diff",
            ["runtime.ts"],
            patch,
        )

        self.assertIn(identifier, redacted_patch)

    def test_local_bundle_allows_deleted_test_token_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            path = repo / "fixture.test.ts"
            path.write_text('const request = { token: "test-token" };\n', encoding="utf-8")
            git(repo, "add", path.name)
            git(repo, "commit", "-q", "-m", "base")

            path.write_text('const request = { token: String() };\n', encoding="utf-8")

            bundle, truncated = self.helper["local_bundle"](repo)

            self.assertIn('-const request = { token: "test-token" };', bundle)
            self.assertFalse(truncated)

    def test_pi_refuses_truncated_review_input(self) -> None:
        reviewer = argparse.Namespace(engine="pi", tools=True)

        with self.assertRaisesRegex(SystemExit, "pi engine refused truncated review input"):
            self.helper["ensure_reviewer_input_complete"](
                reviewer,
                True,
            )

        self.helper["ensure_reviewer_input_complete"](
            reviewer,
            False,
        )
        with self.assertRaisesRegex(SystemExit, "codex engine refused truncated review input"):
            self.helper["ensure_reviewer_input_complete"](
                argparse.Namespace(engine="codex", tools=True),
                True,
            )
        with self.assertRaisesRegex(SystemExit, "claude engine refused truncated review input"):
            self.helper["ensure_reviewer_input_complete"](
                argparse.Namespace(engine="claude", tools=True),
                True,
            )
        with self.assertRaisesRegex(SystemExit, "kimi engine refused truncated review input"):
            self.helper["ensure_reviewer_input_complete"](
                argparse.Namespace(engine="kimi", tools=False),
                True,
            )

    def test_kimi_config_is_sanitized_without_losing_model_auth(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            share = root / "kimi-home"
            share.mkdir()
            (share / "config.toml").write_text(
                "\n".join(
                    [
                        'default_model = "review-model"',
                        'extra_skill_dirs = ["/tmp/unsafe-skills"]',
                        "",
                        "[models.review-model]",
                        'provider = "review-provider"',
                        'model = "kimi-k2"',
                        "max_context_size = 100000",
                        "",
                        "[providers.review-provider]",
                        'type = "kimi"',
                        'base_url = "https://api.example.invalid"',
                        'api_key = "test-token"',
                        "",
                        "[services.moonshot_search]",
                        'base_url = "http://localhost"',
                        "",
                        "[thinking]",
                        "enabled = false",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ,
                {"KIMI_CODE_HOME": str(share)},
                clear=False,
            ):
                config, source_share = self.helper["load_kimi_review_config"](repo)

        self.assertEqual(source_share, share.resolve())
        self.assertEqual(config["default_model"], "review-model")
        self.assertEqual(
            config["providers"]["review-provider"]["api_key"],
            "test-token",
        )
        self.assertNotIn("services", config)
        self.assertNotIn("extra_skill_dirs", config)
        self.assertNotIn("thinking", config)
        self.assertNotIn("hooks", config)

    def test_kimi_oauth_credentials_are_linked_outside_runtime_state(self) -> None:
        if os.name == "nt":
            self.skipTest("directory symlink privileges vary on Windows")
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source_share = root / "source-kimi"
            credentials = source_share / "credentials"
            credentials.mkdir(parents=True)
            device_id = "0123456789abcdef0123456789abcdef"
            (source_share / "device_id").write_text(device_id, encoding="utf-8")
            runtime_share = root / "runtime-kimi"
            runtime_share.mkdir()

            self.helper["prepare_kimi_runtime_auth"](
                repo,
                source_share,
                runtime_share,
            )

            linked = runtime_share / "credentials"
            self.assertTrue(linked.is_symlink())
            self.assertEqual(linked.resolve(), credentials.resolve())
            self.assertEqual(
                (runtime_share / "device_id").read_text(encoding="utf-8"),
                device_id,
            )

    def test_kimi_rejects_repo_controlled_config_symlink(self) -> None:
        if os.name == "nt":
            self.skipTest("directory symlink privileges vary on Windows")
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            hostile_config = repo / "kimi-config.toml"
            hostile_config.write_text("default_model = \"x\"\n", encoding="utf-8")
            share = root / "kimi-home"
            share.mkdir()
            (share / "config.toml").symlink_to(hostile_config)

            with mock.patch.dict(
                os.environ,
                {"KIMI_CODE_HOME": str(share)},
                clear=False,
            ), self.assertRaisesRegex(
                SystemExit,
                "must resolve outside",
            ):
                self.helper["load_kimi_review_config"](repo)

    def test_kimi_engine_env_preserves_only_supported_runtime_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            with mock.patch.dict(
                os.environ,
                {
                    "KIMI_API_KEY": "test-token",
                    "KIMI_BASE_URL": "https://api.example.invalid",
                    "KIMI_MODEL_NAME": "kimi-model",
                    "KIMI_CODE_HOME": str(repo / ".hostile-kimi"),
                    "PYTHONPATH": "/tmp/hostile-python",
                },
                clear=False,
            ):
                env = self.helper["safe_engine_env"](repo, engine="kimi")

        self.assertEqual(env["KIMI_API_KEY"], "test-token")
        self.assertEqual(env["KIMI_BASE_URL"], "https://api.example.invalid")
        self.assertEqual(env["KIMI_MODEL_NAME"], "kimi-model")
        self.assertNotIn("KIMI_CODE_HOME", env)
        self.assertNotIn("PYTHONPATH", env)

    def test_safe_git_env_preserves_trusted_platform_and_helper_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            repo_bin = repo / "bin"
            trusted_bin = root / "trusted-bin"
            repo_bin.mkdir()
            trusted_bin.mkdir()
            with mock.patch.dict(
                os.environ,
                {
                    "PATH": os.pathsep.join((str(repo_bin), str(trusted_bin))),
                    "SYSTEMROOT": "C:\\Windows",
                    "GIT_DIR": str(repo / ".git"),
                    "OPENAI_API_KEY": "must-not-reach-git",
                },
                clear=False,
            ):
                env = self.helper["safe_git_env"](repo)

        self.assertNotIn(str(repo_bin.resolve()), env["PATH"].split(os.pathsep))
        self.assertIn(str(trusted_bin.resolve()), env["PATH"].split(os.pathsep))
        self.assertEqual(env["SYSTEMROOT"], "C:\\Windows")
        self.assertNotIn("GIT_DIR", env)
        self.assertNotIn("OPENAI_API_KEY", env)

    def test_prompt_file_keeps_recoverable_repo_path(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            (repo / "review.md").write_text("review context\n", encoding="utf-8")
            args = argparse.Namespace(prompt=[], prompt_file=["review.md"])

            prompt, truncated = self.helper["load_extra_prompt"](args, repo)

            self.assertIn("# Prompt file: review.md", prompt)
            self.assertFalse(truncated)

    def test_build_prompt_omits_absolute_repo_path_and_caps_aggregate_input(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            prompt = self.helper["build_prompt"](repo, "local", None, "diff", "", "")

            self.assertIn(
                "Review sandbox: . (intentionally contains no reviewed repository files)",
                prompt,
            )
            self.assertIn("Read-only tools cannot access unchanged repository files", prompt)
            self.assertIn(
                "Do not report a missing import, symbol, definition, call site, config entry",
                prompt,
            )
            self.assertNotIn(str(repo), prompt)
            with self.assertRaisesRegex(SystemExit, "aggregate limit"):
                self.helper["build_prompt"](
                    repo,
                    "local",
                    None,
                    "x" * self.helper["MAX_REVIEW_PROMPT_BYTES"],
                    "",
                    "",
                )

    def test_read_text_truncates_without_scanning_tail(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            path = Path(tempdir) / "large.txt"
            path.write_bytes(b"x" * 200_000 + b"\0tail")

            text = self.helper["read_text"](path)

            self.assertIn("[truncated at 180000 characters]", text)
            self.assertNotEqual(text, "[binary file omitted]")

    def test_read_text_marks_unreadable_input_incomplete(self) -> None:
        with mock.patch.dict(
            self.helper["read_text_with_status"].__globals__,
            {"read_prefix": lambda *_args: (_ for _ in ()).throw(SystemExit("denied"))},
        ):
            text, incomplete = self.helper["read_text_with_status"](Path("blocked"))

        self.assertIn("[unreadable:", text)
        self.assertTrue(incomplete)

    def test_evidence_file_must_be_repo_relative_and_not_symlinked(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            outside = root / "outside.md"
            outside.write_text("outside\n", encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "repo-relative"):
                self.helper["validate_evidence_file"](repo, str(outside), "--prompt-file")

            target = repo / "notes.md"
            target.write_text("notes\n", encoding="utf-8")
            link = repo / "link.md"
            try:
                link.symlink_to(target)
            except OSError as exc:
                if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
                    self.skipTest("Windows symlink privilege is not available")
                raise
            with self.assertRaisesRegex(SystemExit, "symlinked"):
                self.helper["validate_evidence_file"](repo, "link.md", "--dataset")

    def test_safe_engine_env_strips_process_injection_variables(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            try:
                os.environ["GIT_DIR"] = "/tmp/unsafe-git-dir"
                os.environ["GIT_CONFIG_COUNT"] = "99"
                os.environ["DYLD_INSERT_LIBRARIES"] = "/tmp/unsafe.dylib"
                os.environ["NODE_OPTIONS"] = "--require=/tmp/unsafe.js"
                os.environ["NODE_PATH"] = "/tmp/unsafe-node"
                os.environ["LD_AUDIT"] = "/tmp/unsafe-audit.so"
                os.environ["LD_LIBRARY_PATH"] = "/tmp/unsafe-lib"
                os.environ["RUBYOPT"] = "-r/tmp/unsafe.rb"
                os.environ["PERL5OPT"] = "-Munsafe"
                os.environ["BUN_OPTIONS"] = "--preload=/tmp/unsafe.js"
                os.environ["OPENCODE_CONFIG"] = "/tmp/unsafe-opencode.json"
                os.environ["OPENCODE_PERMISSION"] = "allow"
                os.environ["OPENCODE_AUTO_SHARE"] = "1"
                os.environ["COPILOT_ALLOW_ALL"] = "1"
                os.environ["CODEX_HOME"] = "/tmp/codex-auth"
                os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
                os.environ["XDG_RUNTIME_DIR"] = "/run/user/1000"
                os.environ["CLAUDE_CONFIG_DIR"] = "/tmp/claude-auth"
                os.environ["PI_CODING_AGENT_DIR"] = "/tmp/pi-auth"
                os.environ["CLAUDE_CODE_USE_FOUNDRY"] = "1"
                os.environ["CLOUD_ML_REGION"] = "us-east5"
                os.environ["ANTHROPIC_AUTH_TOKEN"] = "test-auth-token"
                os.environ["AWS_BEARER_TOKEN_BEDROCK"] = "test-token-placeholder"
                os.environ["ANTHROPIC_BEDROCK_BASE_URL"] = (
                    "https://bedrock.example.invalid"
                )
                os.environ["ANTHROPIC_VERTEX_BASE_URL"] = (
                    "https://vertex.example.invalid"
                )
                os.environ["AWS_PROFILE"] = "review-profile"
                os.environ["AWS_CONFIG_FILE"] = "/tmp/unsafe-aws-config"
                os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = (
                    "/tmp/unsafe-google-credentials"
                )
                os.environ["GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES"] = "1"
                os.environ["OPENROUTER_API_KEY"] = "test-provider-key"
                os.environ["GITHUB_TOKEN"] = "test-token-placeholder"
                os.environ["HTTPS_PROXY"] = "http://proxy.example.invalid:8080"
                os.environ["HTTP_PROXY"] = "proxy.example.invalid:8080"
                os.environ["ALL_PROXY"] = "socks5://proxy.example.invalid:1080"
                os.environ["DO_NOT_TRACK"] = "1"
                os.environ["DISABLE_TELEMETRY"] = "1"
                os.environ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"

                env = self.helper["safe_engine_env"](repo, engine="codex")
                claude_env = self.helper["safe_engine_env"](repo, engine="claude")
                pi_env = self.helper["safe_engine_env"](repo, engine="pi")

                self.assertNotEqual(env.get("GIT_DIR"), "/tmp/unsafe-git-dir")
                self.assertEqual(
                    env["GIT_CONFIG_COUNT"],
                    str(len(self.helper["ENGINE_GIT_CONFIG_OVERRIDES"])),
                )
                self.assertNotIn("DYLD_INSERT_LIBRARIES", env)
                self.assertNotIn("NODE_OPTIONS", env)
                for key in (
                    "NODE_PATH",
                    "LD_AUDIT",
                    "LD_LIBRARY_PATH",
                    "RUBYOPT",
                    "PERL5OPT",
                    "BUN_OPTIONS",
                    "OPENCODE_CONFIG",
                    "OPENCODE_PERMISSION",
                    "OPENCODE_AUTO_SHARE",
                ):
                    self.assertNotIn(key, env)
                self.assertNotIn("COPILOT_ALLOW_ALL", env)
                self.assertNotIn("GITHUB_TOKEN", env)
                self.assertEqual(env["HTTPS_PROXY"], "http://proxy.example.invalid:8080")
                self.assertEqual(env["HTTP_PROXY"], "proxy.example.invalid:8080")
                self.assertEqual(env["ALL_PROXY"], "socks5://proxy.example.invalid:1080")
                self.assertEqual(env["DO_NOT_TRACK"], "1")
                self.assertEqual(env["DISABLE_TELEMETRY"], "1")
                self.assertEqual(env["CODEX_HOME"], "/tmp/codex-auth")
                if os.name == "nt":
                    self.assertNotIn("DBUS_SESSION_BUS_ADDRESS", env)
                else:
                    self.assertEqual(
                        env["DBUS_SESSION_BUS_ADDRESS"],
                        "unix:path=/run/user/1000/bus",
                    )
                self.assertEqual(env["XDG_RUNTIME_DIR"], "/run/user/1000")
                self.assertEqual(
                    claude_env["CLAUDE_CONFIG_DIR"],
                    "/tmp/claude-auth",
                )
                self.assertEqual(
                    claude_env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"],
                    "1",
                )
                self.assertEqual(pi_env["PI_CODING_AGENT_DIR"], "/tmp/pi-auth")
                self.assertEqual(claude_env["CLAUDE_CODE_USE_FOUNDRY"], "1")
                self.assertEqual(claude_env["CLOUD_ML_REGION"], "us-east5")
                self.assertEqual(
                    claude_env["ANTHROPIC_AUTH_TOKEN"],
                    "test-auth-token",
                )
                self.assertEqual(
                    claude_env["AWS_BEARER_TOKEN_BEDROCK"],
                    "test-token-placeholder",
                )
                self.assertEqual(
                    claude_env["ANTHROPIC_BEDROCK_BASE_URL"],
                    "https://bedrock.example.invalid",
                )
                self.assertEqual(
                    claude_env["ANTHROPIC_VERTEX_BASE_URL"],
                    "https://vertex.example.invalid",
                )
                self.assertEqual(claude_env["AWS_PROFILE"], "review-profile")
                self.assertNotIn("AWS_CONFIG_FILE", env)
                self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", env)
                self.assertNotIn(
                    "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
                    env,
                )
                self.assertNotIn("OPENROUTER_API_KEY", env)
                self.assertEqual(
                    claude_env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
                    "1",
                )
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_terminate_process_group_uses_windows_process_api(self) -> None:
        proc = mock.Mock(pid=1234)
        fake_taskkill = r"C:\Windows\System32\taskkill.exe"
        with mock.patch.object(os, "name", "nt"), mock.patch.dict(
            self.helper["terminate_process_group"].__globals__,
            {"_resolve_windows_taskkill": lambda: fake_taskkill},
        ), mock.patch(
            "subprocess.run",
            return_value=subprocess.CompletedProcess([], 0),
        ) as run:
            self.helper["terminate_process_group"](proc, grace_seconds=0.01)
        argv = run.call_args.args[0]
        self.assertEqual(argv, [fake_taskkill, "/PID", "1234", "/T", "/F"])
        # A repo-local taskkill.exe on PATH/CWD must never be reachable here:
        # the resolved argv[0] has to be an absolute path, never the bare name.
        self.assertTrue(PureWindowsPath(argv[0]).is_absolute())
        self.assertNotEqual(argv[0], "taskkill")
        proc.kill.assert_not_called()

    def test_terminate_process_group_skips_taskkill_when_unresolved(self) -> None:
        proc = mock.Mock(pid=1234)
        proc.poll.return_value = None
        with mock.patch.object(os, "name", "nt"), mock.patch.dict(
            self.helper["terminate_process_group"].__globals__,
            {"_resolve_windows_taskkill": lambda: None},
        ), mock.patch("subprocess.run") as run:
            self.helper["terminate_process_group"](proc, grace_seconds=0.01)
        run.assert_not_called()
        proc.kill.assert_called_once()

    def test_terminate_process_group_attempts_taskkill_when_leader_already_exited(
        self,
    ) -> None:
        # Regression for detached descendants leaking: taskkill /T is still
        # worth attempting even once the leader PID has exited (it can still
        # fell the tree while the PID is valid), but the direct-kill fallback
        # only ever makes sense for a leader that is still alive.
        proc = mock.Mock(pid=1234)
        proc.poll.return_value = 0
        fake_taskkill = r"C:\Windows\System32\taskkill.exe"
        with mock.patch.object(os, "name", "nt"), mock.patch.dict(
            self.helper["terminate_process_group"].__globals__,
            {"_resolve_windows_taskkill": lambda: fake_taskkill},
        ), mock.patch(
            "subprocess.run",
            return_value=subprocess.CompletedProcess([], 1),
        ) as run:
            self.helper["terminate_process_group"](proc, grace_seconds=0.01)
        self.assertEqual(run.call_args.args[0][0], fake_taskkill)
        proc.kill.assert_not_called()

    def test_owned_process_registry_terminates_all_tracked_groups(self) -> None:
        terminated: list[object] = []
        proc_a = mock.Mock(pid=111)
        proc_b = mock.Mock(pid=222)
        with mock.patch.dict(
            self.helper["register_owned_process"].__globals__,
            {
                "_signal_owned_process_group": lambda proc: (terminated.append(proc), True)[1],
                "_await_owned_process_groups": lambda procs, grace: None,
                "_enforce_owned_process_group": lambda proc, grace: None,
            },
        ):
            self.helper["register_owned_process"](proc_a)
            self.helper["register_owned_process"](proc_b)
            try:
                self.helper["terminate_owned_processes"]()
            finally:
                self.helper["unregister_owned_process"](proc_a)
                self.helper["unregister_owned_process"](proc_b)
        self.assertEqual(set(terminated), {proc_a, proc_b})

    def test_terminate_owned_processes_signals_all_groups_before_grace_wait(
        self,
    ) -> None:
        # Regression: interrupt handling used to run each group's full
        # terminate-wait-kill sequence serially, so N owned engines cost
        # grace_seconds * N. Phase 1 (signal) must complete for every
        # group before phase 2 (the shared grace wait) starts for any of
        # them.
        order: list[str] = []
        proc_a = mock.Mock(pid=111)
        proc_b = mock.Mock(pid=222)
        proc_gone = mock.Mock(pid=333)

        def fake_signal(proc: object) -> bool:
            order.append(f"signal:{proc.pid}")  # type: ignore[attr-defined]
            return proc is not proc_gone

        def fake_await(procs: list[object], grace_seconds: float) -> None:
            order.append("await:" + ",".join(str(p.pid) for p in procs))  # type: ignore[attr-defined]

        def fake_enforce(proc: object, grace_seconds: float) -> None:
            order.append(f"enforce:{proc.pid}")  # type: ignore[attr-defined]

        with mock.patch.dict(
            self.helper["register_owned_process"].__globals__,
            {
                "_signal_owned_process_group": fake_signal,
                "_await_owned_process_groups": fake_await,
                "_enforce_owned_process_group": fake_enforce,
            },
        ):
            self.helper["register_owned_process"](proc_a)
            self.helper["register_owned_process"](proc_gone)
            self.helper["register_owned_process"](proc_b)
            try:
                self.helper["terminate_owned_processes"]()
            finally:
                self.helper["unregister_owned_process"](proc_a)
                self.helper["unregister_owned_process"](proc_gone)
                self.helper["unregister_owned_process"](proc_b)

        self.assertEqual(
            order,
            [
                "signal:111",
                "signal:333",
                "signal:222",
                "await:111,222",
                "enforce:111",
                "enforce:222",
            ],
        )

    def test_owned_process_grace_deadline_is_shared_across_groups(self) -> None:
        proc_a = mock.Mock()
        proc_b = mock.Mock()
        proc_a.poll.return_value = None
        proc_b.poll.return_value = None
        proc_a.wait.side_effect = subprocess.TimeoutExpired("a", 1.5)
        proc_b.wait.side_effect = subprocess.TimeoutExpired("b", 0.5)

        with mock.patch(
            "time.monotonic",
            side_effect=[10.0, 10.5, 11.5],
        ):
            self.helper["_await_owned_process_groups"](
                [proc_a, proc_b],
                grace_seconds=2.0,
            )

        proc_a.wait.assert_called_once_with(timeout=1.5)
        proc_b.wait.assert_called_once_with(timeout=0.5)

    def test_engine_interrupted_is_not_swallowed_by_except_system_exit(self) -> None:
        # Regression: EngineInterrupted used to subclass SystemExit, so
        # internal `except SystemExit` guards like read_text_with_status's
        # converted an in-flight interrupt into an unreadable-file result
        # and kept going instead of unwinding.
        with mock.patch.dict(
            self.helper["read_text_with_status"].__globals__,
            {"read_prefix": mock.Mock(side_effect=self.helper["EngineInterrupted"](130))},
        ):
            with self.assertRaises(self.helper["EngineInterrupted"]) as ctx:
                self.helper["read_text_with_status"](Path("irrelevant"))
        self.assertEqual(ctx.exception.code, 130)

    def test_main_converts_engine_interrupted_to_exit_code(self) -> None:
        with mock.patch.dict(
            self.helper["main"].__globals__,
            {"main_impl": mock.Mock(side_effect=self.helper["EngineInterrupted"](130))},
        ):
            self.assertEqual(self.helper["main"](), 130)

    def test_source_tree_snapshot_detects_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            source = repo / "source.txt"
            source.write_text("before\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            git(repo, "commit", "-qm", "initial")
            before = self.helper["source_tree_snapshot"](repo)

            source.write_text("after\n", encoding="utf-8")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )
            source.write_text("before\n", encoding="utf-8")
            self.assertEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

            source.write_text("after\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            git(repo, "commit", "-qm", "mutated")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

            (repo / "generated.txt").write_text("generated\n", encoding="utf-8")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

    def test_rejects_output_paths_inside_reviewed_repository(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            outside = root / "outside.json"

            with self.assertRaisesRegex(
                SystemExit,
                "--json-output must point outside",
            ):
                self.helper["reject_repo_output_paths"](
                    argparse.Namespace(
                        json_output=str(repo / "review.json"),
                        output=None,
                    ),
                    repo,
                )
            with self.assertRaisesRegex(
                SystemExit,
                "--output must point outside",
            ):
                self.helper["reject_repo_output_paths"](
                    argparse.Namespace(
                        json_output=None,
                        output=str(repo / "review.txt"),
                    ),
                    repo,
                )

            self.helper["reject_repo_output_paths"](
                argparse.Namespace(
                    json_output=str(outside),
                    output=None,
                ),
                repo,
            )
            alternate_repo = repo.with_name(repo.name.swapcase())
            with (
                mock.patch.object(
                    os.path,
                    "samefile",
                    side_effect=lambda left, right: (
                        str(left).casefold() == str(right).casefold()
                    ),
                ),
                self.assertRaisesRegex(
                    SystemExit,
                    "--json-output must point outside",
                ),
            ):
                self.helper["reject_repo_output_paths"](
                    argparse.Namespace(
                        json_output=str(alternate_repo / "review.json"),
                        output=None,
                    ),
                    repo,
                )

    def test_atomic_output_replaces_hard_link_without_touching_repo_file(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            tracked = repo / "tracked.txt"
            tracked.write_text("tracked\n", encoding="utf-8")
            outside = root / "review.txt"
            os.link(tracked, outside)

            self.helper["atomic_write_text"](outside, "review\n")

            self.assertEqual(
                tracked.read_text(encoding="utf-8"),
                "tracked\n",
            )
            self.assertEqual(
                outside.read_text(encoding="utf-8"),
                "review\n",
            )
            self.assertFalse(os.path.samefile(tracked, outside))

    def test_source_tree_snapshot_supports_staged_files_before_first_commit(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            source = repo / "source.txt"
            source.write_text("before\n", encoding="utf-8")
            git(repo, "add", "source.txt")

            before = self.helper["source_tree_snapshot"](repo)
            symbolic_head = git(repo, "symbolic-ref", "HEAD").strip()
            self.assertEqual(before[0], f"unborn:{symbolic_head}")

            git(repo, "symbolic-ref", "HEAD", "refs/heads/other")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )
            git(repo, "symbolic-ref", "HEAD", symbolic_head)

            source.write_text("after\n", encoding="utf-8")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

    @unittest.skipIf(os.name == "nt", "the true command is POSIX-only")
    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_cli_detects_source_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("before\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            git(repo, "commit", "-qm", "initial")
            source.write_text("review me\n", encoding="utf-8")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            record_path = root / "record.json"
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env.update(
                {
                    "AUTOREVIEW_FAKE_MUTATE": str(source),
                    "AUTOREVIEW_FAKE_RECORD": str(record_path),
                    "HOME": str(root),
                    "USERPROFILE": str(root),
                }
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn(
                "source changed after the review bundle was created",
                result.stderr,
            )
            self.assertTrue(record_path.is_file())

    def test_source_tree_snapshot_hashes_binary_and_untracked_tail_bytes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            tracked = repo / "tracked.bin"
            tracked.write_bytes(b"\0tracked-before")
            git(repo, "add", "tracked.bin")
            git(repo, "commit", "-qm", "initial")
            limit = self.helper["MAX_BUNDLE_TEXT_BYTES"]
            untracked = repo / "generated.bin"
            untracked.write_bytes(b"\0" + b"a" * (limit + 16))
            before = self.helper["source_tree_snapshot"](repo)

            tracked.write_bytes(b"\0tracked-after!")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )
            tracked.write_bytes(b"\0tracked-before")
            self.assertEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

            with untracked.open("r+b") as stream:
                stream.seek(-1, os.SEEK_END)
                stream.write(b"b")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

    def test_source_tree_snapshot_includes_index_state(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            source = repo / "source.txt"
            source.write_text("before\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            git(repo, "commit", "-qm", "initial")
            before = self.helper["source_tree_snapshot"](repo)

            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            source.write_text("before\n", encoding="utf-8")
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

    def test_source_tree_snapshot_includes_tracked_submodule_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            child = root / "child"
            child.mkdir()
            git(child, "init", "-q")
            source = child / "source.txt"
            source.write_text("before\n", encoding="utf-8")
            git(child, "add", "source.txt")
            git(child, "commit", "-qm", "initial")

            repo = init_repo(root)
            git(
                repo,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                str(child),
                "vendor/dependency",
            )
            git(repo, "commit", "-qam", "add submodule")
            before = self.helper["source_tree_snapshot"](repo)

            (repo / "vendor/dependency/source.txt").write_text(
                "after\n",
                encoding="utf-8",
            )
            self.assertNotEqual(
                self.helper["source_tree_snapshot"](repo),
                before,
            )

    def test_installed_java_rejects_launcher_without_runtime(self) -> None:
        launcher = "/usr/bin/java"
        unavailable = subprocess.CompletedProcess([launcher, "-version"], 1)
        with (
            mock.patch("shutil.which", return_value=launcher),
            mock.patch("subprocess.run", return_value=unavailable),
        ):
            self.assertIsNone(installed_java())

    def test_safe_proxy_url_accepts_credential_free_formats(self) -> None:
        for value in (
            "http://proxy.example.invalid:8080",
            "proxy.example.invalid:8080",
            "socks4://proxy.example.invalid",
            "socks4a://proxy.example.invalid",
        ):
            with self.subTest(value=value):
                self.assertTrue(self.helper["safe_proxy_url"](value))

        for value in (
            "http://review-user:review-password@proxy.example.invalid:8080",
            "socks5://review-user:review-password@proxy.example.invalid:1080",
        ):
            with self.subTest(value=value):
                self.assertFalse(self.helper["safe_proxy_url"](value))

    def test_safe_engine_env_rejects_credentialed_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(
            os.environ,
            {
                "HTTPS_PROXY": (
                    "http://review-user:review-password@proxy.example.invalid:8080"
                )
            },
            clear=False,
        ):
            repo = init_repo(Path(tempdir))
            with self.assertRaisesRegex(SystemExit, "credentialed or malformed proxy"):
                self.helper["safe_engine_env"](repo, engine="codex")

    def test_safe_temp_root_rejects_reviewed_repo_parent(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            hostile_temp = repo / "tmp"
            hostile_temp.mkdir()

            with mock.patch.object(
                tempfile,
                "gettempdir",
                return_value=str(hostile_temp),
            ), self.assertRaisesRegex(
                SystemExit,
                "temporary directory must be outside",
            ):
                self.helper["safe_temp_root"](repo)

    @unittest.skipIf(os.name == "nt", "POSIX Testbox temp-root behavior")
    def test_claude_fable_alias_requires_fable_safe_mode_version(self) -> None:
        args = argparse.Namespace(
            claude_bin="claude",
            fallback_model=None,
            model="fable",
        )
        version_result = subprocess.CompletedProcess(
            ["claude", "--version"],
            0,
            "2.1.169 (Claude Code)",
            "",
        )

        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            with mock.patch.dict(
                self.helper["ensure_claude_isolation_supported"].__globals__,
                {
                    "resolve_command": lambda *_args: "/usr/bin/claude",
                    "safe_engine_env": lambda *_args, **_kwargs: {},
                    "safe_temp_root": lambda _repo: Path(tempdir),
                    "run": lambda *_args, **_kwargs: version_result,
                },
            ), self.assertRaisesRegex(
                SystemExit,
                "2.1.170",
            ):
                self.helper["ensure_claude_isolation_supported"](args, repo)

    def test_claude_canonical_fable_model_uses_portable_cli_selector(self) -> None:
        self.assertEqual(
            self.helper["claude_cli_model_selector"]("claude-fable-5"),
            "fable",
        )
        self.assertEqual(
            self.helper["claude_cli_fallback_models"](
                "claude-fable-5,claude-opus-5"
            ),
            "fable,claude-opus-5",
        )

    def test_claude_runs_outside_repo_with_auto_memory_disabled(self) -> None:
        args = argparse.Namespace(
            claude_allowed_tools=None,
            claude_bin="claude",
            fallback_model=None,
            model=None,
            stream_engine_output=False,
            thinking=None,
            tools=False,
            web_search=False,
        )
        observed: dict[str, object] = {}

        def fake_run(
            _cmd: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            observed["cwd"] = cwd
            observed["env"] = kwargs["env"]
            return subprocess.CompletedProcess([], 0, "{}", "")

        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            with mock.patch.dict(
                self.helper["run_claude"].__globals__,
                {
                    "ensure_claude_isolation_supported": lambda *_args: None,
                    "resolve_command": lambda *_args: "/usr/bin/claude",
                    "run_with_heartbeat": fake_run,
                    "safe_engine_env": lambda *_args, **_kwargs: {
                        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"
                    },
                },
            ):
                self.helper["run_claude"](args, repo, "prompt")

            self.assertFalse(
                self.helper["is_within"](observed["cwd"], repo.resolve())
            )
            self.assertEqual(
                observed["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"],
                "1",
            )

    def test_codex_env_rejects_executable_dbus_transport(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            try:
                os.environ["DBUS_SESSION_BUS_ADDRESS"] = (
                    "unixexec:path=/tmp/hostile-helper"
                )
                env = self.helper["safe_engine_env"](repo, engine="codex")
                self.assertNotIn("DBUS_SESSION_BUS_ADDRESS", env)
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_multi_provider_engines_preserve_provider_auth(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir).resolve()
            repo = init_repo(root)
            try:
                os.environ["DEEPSEEK_API_KEY"] = "test-token-placeholder"
                os.environ["CEREBRAS_API_KEY"] = "test-token-placeholder"
                os.environ["CLOUDFLARE_ACCOUNT_ID"] = "test-account"
                os.environ["CLOUDFLARE_API_TOKEN"] = "test-token-placeholder"
                os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = (
                    str(root / "provider-credentials.json")
                )
                os.environ["AWS_ROLE_ARN"] = (
                    "arn:aws:iam::123456789012:role/autoreview"
                )
                os.environ["AWS_CONTAINER_AUTHORIZATION_TOKEN"] = (
                    "test-token-placeholder"
                )
                os.environ["AWS_CONTAINER_CREDENTIALS_FULL_URI"] = (
                    "http://169.254.170.2/credentials"
                )
                os.environ["AWS_WEB_IDENTITY_TOKEN_FILE"] = str(
                    root / "web-identity",
                )
                os.environ["AWS_CONFIG_FILE"] = str(root / "aws-config")
                os.environ["AWS_SHARED_CREDENTIALS_FILE"] = str(
                    root / "aws-credentials",
                )
                os.environ["NODE_EXTRA_CA_CERTS"] = str(root / "corporate-ca.pem")
                os.environ["SSL_CERT_FILE"] = str(root / "tls-ca.pem")
                os.environ["SSL_CERT_DIR"] = str(root / "tls-ca")
                os.environ["SNOWFLAKE_ACCOUNT"] = "test-account"
                os.environ["SNOWFLAKE_CORTEX_TOKEN"] = "test-token-placeholder"
                os.environ["AZURE_RESOURCE_NAME"] = "test-resource"
                os.environ["ANTHROPIC_OAUTH_TOKEN"] = "test-token-placeholder"
                os.environ["AWS_BEDROCK_FORCE_HTTP1"] = "1"
                os.environ["AWS_BEDROCK_SKIP_AUTH"] = "1"
                os.environ["AZURE_CLIENT_ID"] = "test-client"
                os.environ["AZURE_CLIENT_SECRET"] = "test-token-placeholder"
                os.environ["AZURE_TENANT_ID"] = "test-tenant"
                os.environ["GCLOUD_PROJECT"] = "test-project"
                os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"
                os.environ["CODEX_API_KEY"] = "test-token-placeholder"
                os.environ["CODEX_CA_CERTIFICATE"] = str(root / "codex-ca.pem")
                os.environ["COPILOT_GITHUB_TOKEN"] = "test-token-placeholder"
                os.environ["PI_OFFLINE"] = "1"
                os.environ["PI_SKIP_VERSION_CHECK"] = "1"
                os.environ["PI_TELEMETRY"] = "0"
                os.environ["NPM_TOKEN"] = "test-token-placeholder"
                os.environ["SENTRY_API_KEY"] = "test-token-placeholder"
                os.environ["SENTRY_AUTH_TOKEN"] = "test-token-placeholder"
                os.environ["DIGITALOCEAN_ACCESS_TOKEN"] = "test-token-placeholder"
                os.environ["GITLAB_TOKEN"] = "test-token-placeholder"
                os.environ["NODE_OPTIONS"] = "--require=/tmp/unsafe.js"
                os.environ["GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES"] = "1"
                env = self.helper["safe_engine_env"](repo, engine="pi")
                for key in (
                            "AWS_ROLE_ARN",
                            "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                            "AWS_BEDROCK_FORCE_HTTP1",
                            "AWS_BEDROCK_SKIP_AUTH",
                            "AWS_CONFIG_FILE",
                            "AWS_SHARED_CREDENTIALS_FILE",
                            "AWS_WEB_IDENTITY_TOKEN_FILE",
                            "CEREBRAS_API_KEY",
                            "CLOUDFLARE_ACCOUNT_ID",
                            "CLOUDFLARE_API_TOKEN",
                            "COPILOT_GITHUB_TOKEN",
                            "DEEPSEEK_API_KEY",
                            "GOOGLE_APPLICATION_CREDENTIALS",
                            "NODE_EXTRA_CA_CERTS",
                            "SSL_CERT_DIR",
                            "SSL_CERT_FILE",
                            "SNOWFLAKE_ACCOUNT",
                            "SNOWFLAKE_CORTEX_TOKEN",
                            "AZURE_RESOURCE_NAME",
                            "ANTHROPIC_OAUTH_TOKEN",
                ):
                    self.assertEqual(env[key], os.environ[key])
                self.assertNotIn("NODE_OPTIONS", env)
                self.assertNotIn("NPM_TOKEN", env)
                self.assertNotIn("SENTRY_API_KEY", env)
                self.assertNotIn("SENTRY_AUTH_TOKEN", env)
                self.assertNotIn("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES", env)
                self.assertNotIn("DIGITALOCEAN_ACCESS_TOKEN", env)
                self.assertNotIn("GITLAB_TOKEN", env)
                self.assertEqual(env["PI_OFFLINE"], "1")
                self.assertEqual(env["PI_SKIP_VERSION_CHECK"], "1")
                self.assertEqual(env["PI_TELEMETRY"], "0")

                claude_env = self.helper["safe_engine_env"](repo, engine="claude")
                for key in (
                    "AZURE_CLIENT_ID",
                    "AZURE_CLIENT_SECRET",
                    "AZURE_TENANT_ID",
                    "GCLOUD_PROJECT",
                    "GOOGLE_CLOUD_PROJECT",
                    "AWS_ROLE_ARN",
                    "AWS_CONFIG_FILE",
                    "AWS_SHARED_CREDENTIALS_FILE",
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    "NODE_EXTRA_CA_CERTS",
                    "SSL_CERT_DIR",
                    "SSL_CERT_FILE",
                ):
                    self.assertEqual(claude_env[key], os.environ[key])
                self.assertNotIn("DEEPSEEK_API_KEY", claude_env)
                self.assertNotIn("NODE_OPTIONS", claude_env)
                codex_env = self.helper["safe_engine_env"](repo, engine="codex")
                for key in (
                    "CODEX_API_KEY",
                    "CODEX_CA_CERTIFICATE",
                    "SSL_CERT_DIR",
                    "SSL_CERT_FILE",
                ):
                    self.assertEqual(codex_env[key], os.environ[key])
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_multi_provider_custom_credentials_require_explicit_safe_names(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            try:
                os.environ["CORP_LLM_API_KEY"] = "test-token-placeholder"
                os.environ["CORP_AUTH_TOKEN"] = "test-token-placeholder"
                os.environ["AUTOREVIEW_PROVIDER_ENV_ALLOW"] = (
                    "CORP_LLM_API_KEY,CORP_AUTH_TOKEN"
                )

                env = self.helper["safe_engine_env"](repo, engine="pi")
                self.assertEqual(env["CORP_LLM_API_KEY"], os.environ["CORP_LLM_API_KEY"])
                self.assertEqual(env["CORP_AUTH_TOKEN"], os.environ["CORP_AUTH_TOKEN"])
                self.assertNotIn("AUTOREVIEW_PROVIDER_ENV_ALLOW", env)

                os.environ["AUTOREVIEW_PROVIDER_ENV_ALLOW"] = "NODE_OPTIONS"
                with self.assertRaisesRegex(
                    SystemExit,
                    "invalid AUTOREVIEW_PROVIDER_ENV_ALLOW entry",
                ):
                    self.helper["safe_engine_env"](repo, engine="pi")
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_provider_credential_paths_are_forwarded_as_absolute(self) -> None:
        old_env = os.environ.copy()
        old_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            try:
                os.chdir(repo)
                os.environ["AWS_CONFIG_FILE"] = "../shared/aws-config"
                os.environ["SSL_CERT_DIR"] = os.pathsep.join(
                    ("../tls/one", "../tls/two"),
                )

                env = self.helper["safe_engine_env"](repo, engine="pi")

                self.assertEqual(
                    env["AWS_CONFIG_FILE"],
                    str((root / "shared" / "aws-config").resolve()),
                )
                self.assertEqual(
                    env["SSL_CERT_DIR"],
                    os.pathsep.join(
                        (
                            str((root / "tls" / "one").resolve()),
                            str((root / "tls" / "two").resolve()),
                        )
                    ),
                )
            finally:
                os.chdir(old_cwd)
                os.environ.clear()
                os.environ.update(old_env)

    def test_engines_reject_repo_local_config_roots(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            try:
                os.environ["CLAUDE_CONFIG_DIR"] = str(repo / ".claude")
                os.environ["CODEX_HOME"] = str(repo / ".codex")
                os.environ["PI_CODING_AGENT_DIR"] = str(repo / ".pi")
                os.environ["CODEX_CA_CERTIFICATE"] = str(repo / "codex-ca.pem")
                os.environ["SSL_CERT_FILE"] = str(repo / "tls-ca.pem")
                os.environ["HOME"] = str(repo)
                os.environ["USERPROFILE"] = str(repo)
                claude_env = self.helper["safe_engine_env"](repo, engine="claude")
                codex_env = self.helper["safe_engine_env"](repo, engine="codex")
                pi_env = self.helper["safe_engine_env"](repo, engine="pi")
                self.assertNotIn("CLAUDE_CONFIG_DIR", claude_env)
                self.assertNotIn("CODEX_HOME", codex_env)
                self.assertNotIn("CODEX_CA_CERTIFICATE", codex_env)
                self.assertNotIn("SSL_CERT_FILE", codex_env)
                self.assertNotIn("PI_CODING_AGENT_DIR", pi_env)
                self.assertNotIn("HOME", claude_env)
                self.assertNotIn("USERPROFILE", claude_env)
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_codex_auth_config_ignores_repo_local_home(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            config_dir = repo / ".codex"
            config_dir.mkdir()
            (config_dir / "config.toml").write_text(
                'forced_login_method = "api"\n',
                encoding="utf-8",
            )
            try:
                os.environ["CODEX_HOME"] = str(config_dir)
                self.assertEqual(self.helper["codex_auth_config_flags"](repo), [])
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_codex_runtime_home_links_only_auth_and_persists_refresh(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source_home = root / "host-home" / ".codex"
            runtime_home = root / "runtime" / "codex-home"
            source_home.mkdir(parents=True)
            source_auth = source_home / "auth.json"
            source_auth.write_text(
                '{"token":"test-token-placeholder"}',
                encoding="utf-8",
            )
            (source_home / "config.toml").write_text(
                'cli_auth_credentials_store = "file"\n',
                encoding="utf-8",
            )
            try:
                os.environ["CODEX_HOME"] = str(source_home)
                linked = self.helper["prepare_codex_runtime_auth"](repo, runtime_home)
                self.assertTrue(linked)
                self.assertTrue((runtime_home / "auth.json").is_file())
                self.assertTrue(
                    os.path.samefile(source_auth, runtime_home / "auth.json")
                )
                self.assertFalse((runtime_home / "config.toml").exists())
                self.assertIn(
                    'cli_auth_credentials_store="file"',
                    self.helper["codex_auth_config_flags"](
                        repo,
                        force_file=True,
                    ),
                )

                (runtime_home / "auth.json").write_text(
                    '{"token":"test-auth-token"}',
                    encoding="utf-8",
                )
                self.assertEqual(
                    json.loads(source_auth.read_text(encoding="utf-8"))["token"],
                    "test-auth-token",
                )
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_codex_runtime_home_does_not_promote_keyring_fallback_file(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source_home = root / "host-home" / ".codex"
            source_home.mkdir(parents=True)
            (source_home / "auth.json").write_text(
                '{"token":"test-token-placeholder"}',
                encoding="utf-8",
            )
            (source_home / "config.toml").write_text(
                'cli_auth_credentials_store = "keyring"\n',
                encoding="utf-8",
            )
            try:
                os.environ["CODEX_HOME"] = str(source_home)
                self.assertFalse(
                    self.helper["prepare_codex_runtime_auth"](
                        repo,
                        root / "runtime" / "codex-home",
                    )
                )
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_codex_runtime_home_fails_closed_when_linking_is_unavailable(
        self,
    ) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source_home = root / "host-home" / ".codex"
            source_home.mkdir(parents=True)
            source_auth = source_home / "auth.json"
            source_auth.write_text(
                '{"token":"test-token-placeholder"}',
                encoding="utf-8",
            )
            try:
                os.environ["CODEX_HOME"] = str(source_home)
                with (
                    mock.patch("os.link", side_effect=OSError("blocked")),
                    mock.patch.object(
                        Path,
                        "symlink_to",
                        side_effect=OSError("blocked"),
                    ),
                    self.assertRaisesRegex(
                        SystemExit,
                        "unable to isolate Codex file authentication",
                    ),
                ):
                    self.helper["prepare_codex_runtime_auth"](
                        repo,
                        root / "runtime" / "codex-home",
                    )
                self.assertEqual(
                    json.loads(source_auth.read_text(encoding="utf-8"))["token"],
                    "test-token-placeholder",
                )
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_codex_runtime_home_preserves_auto_keyring_namespace(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source_home = root / "host-home" / ".codex"
            runtime_home = root / "runtime" / "codex-home"
            source_home.mkdir(parents=True)
            (source_home / "auth.json").write_text(
                '{"token":"test-token-placeholder"}',
                encoding="utf-8",
            )
            (source_home / "config.toml").write_text(
                'cli_auth_credentials_store = "auto"\n',
                encoding="utf-8",
            )
            try:
                os.environ["CODEX_HOME"] = str(source_home)
                linked = self.helper["prepare_codex_runtime_auth"](
                    repo,
                    runtime_home,
                )
                self.assertFalse(linked)
                flags = self.helper["codex_auth_config_flags"](repo)
                self.assertIn('cli_auth_credentials_store="auto"', flags)
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_empty_codex_home_uses_external_default(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            default_home = root / "host-home" / ".codex"
            default_home.mkdir(parents=True)
            try:
                os.environ["CODEX_HOME"] = ""
                with mock.patch.object(
                    Path,
                    "home",
                    return_value=default_home.parent,
                ):
                    self.assertEqual(
                        self.helper["codex_source_home"](repo),
                        default_home.resolve(),
                    )
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_empty_codex_home_ignores_missing_default(self) -> None:
        old = os.environ.copy()
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            missing_home = root / "missing-home"
            try:
                os.environ["CODEX_HOME"] = ""
                with mock.patch.object(
                    Path,
                    "home",
                    return_value=missing_home,
                ):
                    self.assertIsNone(
                        self.helper["codex_source_home"](repo)
                    )
            finally:
                os.environ.clear()
                os.environ.update(old)

    def test_codex_isolation_restricts_tool_environment(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            runtime_root = root / "runtime"
            flags = self.helper["codex_config_isolation_flags"](
                repo,
                runtime_root,
            )

        for required in (
            f"sqlite_home={json.dumps(str((runtime_root / 'state').resolve()))}",
            f"log_dir={json.dumps(str((runtime_root / 'log').resolve()))}",
            "features.shell_snapshot=false",
            "features.hooks=false",
            "features.plugins=false",
            "skills.include_instructions=false",
            "skills.config=[]",
            'shell_environment_policy.inherit="core"',
            "shell_environment_policy.ignore_default_excludes=false",
            "shell_environment_policy.experimental_use_profile=false",
            "allow_login_shell=false",
            'default_permissions="autoreview"',
            'permissions.autoreview.filesystem={":minimal"="read",":workspace_roots"="read"}',
        ):
            self.assertIn(required, flags)
        set_flag = next(
            flag for flag in flags if flag.startswith("shell_environment_policy.set=")
        )
        for key, value in self.helper["codex_tool_git_env"]().items():
            self.assertIn(f"{key}={json.dumps(value)}", set_flag)

    def test_safe_engine_env_excludes_repo_local_path_entries(self) -> None:
        old_path = os.environ.get("PATH", "")
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            os.environ["PATH"] = f"{repo}{os.pathsep}{old_path}"
            try:
                env = self.helper["safe_engine_env"](repo, engine="codex")
            finally:
                os.environ["PATH"] = old_path

            self.assertNotIn(str(repo.resolve()), env["PATH"].split(os.pathsep))

    def test_find_command_rejects_explicit_repo_local_executables(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            (repo / "tools").mkdir()
            (root / "trusted").mkdir()
            repo_bin = write_executable(
                repo / "tools" / "codex",
                "#!/bin/sh\nexit 0\n",
            )
            external_bin = write_executable(
                root / "trusted" / "codex",
                "#!/bin/sh\nexit 0\n",
            )

            self.assertIsNone(
                self.helper["find_command"]("tools/codex", repo),
            )
            self.assertIsNone(
                self.helper["find_command"](str(repo_bin), repo),
            )
            self.assertEqual(
                self.helper["find_command"](str(external_bin), repo),
                str(Path(os.path.abspath(external_bin))),
            )
            self.assertEqual(
                self.helper["find_command"]("../trusted/codex", repo),
                str(Path(os.path.abspath(external_bin))),
            )

            external_link = root / "trusted" / "external-codex"
            repo_link = repo / "tools" / "external-codex"
            try:
                external_link.symlink_to(repo_bin)
                repo_link.symlink_to(external_bin)
            except OSError as exc:
                if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
                    return
                raise
            self.assertIsNone(
                self.helper["find_command"](str(external_link), repo),
            )
            self.assertIsNone(
                self.helper["find_command"](str(repo_link), repo),
            )

    def test_validate_report_normalizes_relative_finding_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            report = {
                "findings": [
                    {
                        "title": "Finding",
                        "body": "Body",
                        "priority": "P1",
                        "confidence": 0.9,
                        "category": "bug",
                        "code_location": {"file_path": r".\src\index.ts", "line": 1},
                    }
                ],
                "overall_correctness": "patch is incorrect",
                "overall_explanation": "Explanation",
                "overall_confidence": 0.9,
            }

            self.helper["validate_report"](report, repo, {"src/index.ts"}, [])

            self.assertEqual(report["findings"][0]["code_location"]["file_path"], "src/index.ts")

            report["findings"][0]["code_location"]["file_path"] = r"src\index.ts"
            self.helper["validate_report"](report, repo, {r"src\index.ts"}, [])
            self.assertEqual(
                report["findings"][0]["code_location"]["file_path"],
                r"src\index.ts",
            )

            report["findings"][0]["code_location"]["file_path"] = " "
            with self.assertRaisesRegex(SystemExit, "invalid location"):
                self.helper["validate_report"](report, repo, {"src/index.ts"}, [])

            for invalid_path in (123, None, True):
                with self.subTest(invalid_path=invalid_path):
                    report["findings"][0]["code_location"] = {
                        "file_path": invalid_path,
                        "line": 1,
                    }
                    with self.assertRaisesRegex(SystemExit, "invalid location"):
                        self.helper["validate_report"](
                            report,
                            repo,
                            {"src/index.ts"},
                            [],
                        )

            report["findings"][0]["code_location"] = {
                "file_path": "src/index.ts",
                "line": True,
            }
            with self.assertRaisesRegex(SystemExit, "invalid location"):
                self.helper["validate_report"](report, repo, {"src/index.ts"}, [])

            report["findings"][0]["code_location"] = {
                "file_path": "src/index.ts",
                "line": 1,
                "extra": "ignored",
            }
            with self.assertRaisesRegex(
                SystemExit,
                "invalid code_location keys",
            ):
                self.helper["validate_report"](report, repo, {"src/index.ts"}, [])

    def test_print_report_escapes_terminal_controls(self) -> None:
        report = {
            "findings": [
                {
                    "title": "clear\x1b[2Jscreen",
                    "body": "first line\nsecond\u202eline café\udc9b",
                    "priority": "P1",
                    "confidence": 0.9,
                    "category": "security",
                    "code_location": {
                        "file_path": "src/\x9b2Jfile.py",
                        "line": 1,
                    },
                }
            ],
            "overall_correctness": "patch is incorrect",
            "overall_explanation": "explanation\x07",
            "overall_confidence": 0.9,
        }
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            self.helper["print_report"](report, label="review\x00label")

        rendered = output.getvalue()
        for control in (
            "\x00",
            "\x07",
            "\x1b",
            "\x9b",
            "\u202e",
            "\udc9b",
        ):
            self.assertNotIn(control, rendered)
        for escaped in (
            r"review\x00label",
            r"clear\x1b[2Jscreen",
            r"src/\x9b2Jfile.py",
            r"second\u202eline café\udc9b",
            r"explanation\x07",
        ):
            self.assertIn(escaped, rendered)
        self.assertIn("first line\nsecond", rendered)

    def test_validate_report_escapes_controls_in_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            report = {
                "findings": [
                    {
                        "title": "Finding",
                        "body": "Body",
                        "priority": "P1\x1b]52;c;VEVTVA==\x07",
                        "confidence": 0.9,
                        "category": "security",
                        "code_location": {
                            "file_path": "src/index.py",
                            "line": 1,
                        },
                    }
                ],
                "overall_correctness": "patch is incorrect",
                "overall_explanation": "Explanation",
                "overall_confidence": 0.9,
            }

            with self.assertRaises(SystemExit) as raised:
                self.helper["validate_report"](
                    report,
                    repo,
                    {"src/index.py"},
                    [],
                )

        message = str(raised.exception)
        self.assertNotIn("\x1b", message)
        self.assertNotIn("\x07", message)
        self.assertIn(r"P1\x1b]52;c;VEVTVA==\x07", message)

    def test_safe_engine_env_ignores_inaccessible_path_entries(self) -> None:
        old_path = os.environ.get("PATH", "")
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            blocked = root / "blocked"
            os.environ["PATH"] = f"{blocked}{os.pathsep}{old_path}"
            original_exists = Path.exists

            def fake_exists(path: Path) -> bool:
                if str(path) == str(blocked):
                    raise PermissionError("access denied")
                return original_exists(path)

            try:
                with mock.patch.object(Path, "exists", fake_exists):
                    env = self.helper["safe_engine_env"](repo, engine="codex")
            finally:
                os.environ["PATH"] = old_path

            self.assertNotIn(str(blocked), env["PATH"].split(os.pathsep))

    def test_run_with_heartbeat_replaces_undecodable_engine_output(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            result = self.helper["run_with_heartbeat"](
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stdout.buffer.write(b'\\x90\\n')",
                ],
                Path(tempdir),
                label="decode-test",
                heartbeat_seconds=1,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\ufffd", result.stdout)

    def test_run_with_heartbeat_bounds_a_silent_reviewer_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            result = self.helper["run_with_heartbeat"](
                [sys.executable, "-c", "import time; time.sleep(2)"],
                Path(tempdir),
                label="silent-reviewer",
                heartbeat_seconds=0.01,
                max_runtime_seconds=0.05,
            )

        self.assertEqual(result.returncode, 124)
        self.assertIn("silent-reviewer engine timed out after 0.05s", result.stderr)

    def test_engine_timeout_accepts_only_positive_finite_seconds(self) -> None:
        parser = self.helper["positive_float"]
        self.assertEqual(parser("1800"), 1800)
        for value in ("0", "-1", "nan", "inf", "soon"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                parser(value)

    def test_reviewer_runtime_deadline_is_disabled_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            result = self.helper["run_with_heartbeat"](
                [sys.executable, "-c", "import time; time.sleep(0.05)"],
                Path(tempdir),
                label="compatible-reviewer",
                heartbeat_seconds=0.01,
            )

        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(os.name == "posix", "process groups require POSIX")
    def test_streaming_deadline_kills_sigterm_resistant_continuous_output(self) -> None:
        child = (
            "import signal,time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "time.sleep(60)"
        )
        script = (
            "import signal,subprocess,sys,time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            f"child=subprocess.Popen([sys.executable, '-c', {child!r}]); "
            "print(child.pid, flush=True); "
            "\nwhile True: print('tick', flush=True); time.sleep(0.005)"
        )
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as tempdir:
            result = self.helper["run_with_heartbeat"](
                [sys.executable, "-c", script],
                Path(tempdir),
                label="streaming-reviewer",
                heartbeat_seconds=0.01,
                max_runtime_seconds=0.05,
                stream_output=True,
                stream_display=lambda _name, _line: None,
            )
        elapsed = time.monotonic() - started

        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn("tick", result.stdout)
        self.assertIn("streaming-reviewer engine timed out after 0.05s", result.stderr)
        self.assertLess(elapsed, 5)
        child_pid = int(result.stdout.splitlines()[0])
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)

    @unittest.skipUnless(os.name == "posix", "detached process groups require POSIX")
    def test_deadline_bounds_drain_when_descendant_retains_pipe(self) -> None:
        child = "import time; time.sleep(60)"
        script = (
            "import subprocess,sys; "
            f"child=subprocess.Popen([sys.executable, '-c', {child!r}], start_new_session=True); "
            "print(child.pid, flush=True)"
        )
        for stream_output in (False, True):
            with self.subTest(stream_output=stream_output):
                child_pid: int | None = None
                started = time.monotonic()
                try:
                    with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(
                        self.helper["EngineRuntimeDeadline"].terminate.__globals__,
                        {
                            "_TIMED_OUT_STREAM_DRAIN_SECONDS": 0.05,
                            # Model Windows' documented best-effort cleanup: the
                            # leader is reaped while its detached descendant and
                            # inherited output handle survive.
                            "terminate_process_group": lambda proc: proc.poll(),
                        },
                    ):
                        result = self.helper["run_with_heartbeat"](
                            [sys.executable, "-c", script],
                            Path(tempdir),
                            label="retained-pipe-reviewer",
                            heartbeat_seconds=0.01,
                            max_runtime_seconds=0.05,
                            stream_output=stream_output,
                            stream_display=lambda _name, _line: None,
                        )
                    child_pid = int(result.stdout.strip())
                finally:
                    if child_pid is not None:
                        try:
                            os.kill(child_pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

                self.assertEqual(result.returncode, 124, result.stderr)
                self.assertIn("retained-pipe-reviewer engine timed out", result.stderr)
                self.assertLess(time.monotonic() - started, 1)

    def test_large_repo_relative_evidence_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            repo = init_repo(Path(tempdir))
            evidence = repo / "evidence.txt"
            evidence.write_text("x" * 600_000, encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "file too large to scan safely"):
                self.helper["validate_evidence_file"](
                    repo,
                    "evidence.txt",
                    "--dataset",
                )

    def test_claude_inventory_is_bundle_and_web_only(self) -> None:
        args = argparse.Namespace(
            claude_allowed_tools="WebFetch(domain:docs.example.com),WebSearch",
            web_search=True,
        )

        self.assertEqual(
            self.helper["claude_allowed_tools"](args),
            "WebFetch(domain:docs.example.com),WebSearch",
        )
        self.assertEqual(
            self.helper["claude_tool_inventory"](args),
            "WebFetch,WebSearch",
        )

        args.web_search = False
        self.assertEqual(
            self.helper["claude_allowed_tools"](args),
            "",
        )

        args.claude_allowed_tools = "Read"
        with self.assertRaisesRegex(SystemExit, "not read-only"):
            self.helper["claude_tool_inventory"](args)

        args.web_search = True
        args.claude_allowed_tools = "WebFetch"
        with self.assertRaisesRegex(SystemExit, "one explicit domain"):
            self.helper["claude_tool_inventory"](args)

    def test_review_patch_allows_safe_multiline_call_hunks(self) -> None:
        patch = (
            "diff --git a/safe.py b/safe.py\n"
            "--- a/safe.py\n"
            "+++ b/safe.py\n"
            "@@ -0,0 +1,3 @@\n"
            "+"
            + "pass"
            + "word = getpass.getpass(\n"
            '+    "Password: ",\n'
            "+)\n"
        )

        self.assertEqual(
            self.helper["validate_review_patch"](
                "local unstaged diff",
                ["safe.py"],
                patch,
            ),
            patch,
        )

    def test_stream_displays_escape_terminal_controls(self) -> None:
        control = chr(27) + "]52;c;VEVTVA==" + chr(7)
        codex = self.helper["CodexStreamDisplay"]()
        claude = self.helper["ClaudeStreamDisplay"]()
        codex_message = json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": control,
                },
            }
        )

        for displayed in (
            codex("stdout", codex_message + "\n"),
            codex("stderr", control + "\n"),
            claude("stderr", control + "\n"),
        ):
            self.assertIsNotNone(displayed)
            assert displayed is not None
            self.assertNotIn(chr(27), displayed)
            self.assertNotIn(chr(7), displayed)
            self.assertIn(r"\x1b", displayed)
            self.assertIn(r"\x07", displayed)
            self.assertTrue(displayed.endswith("\n"))

    def test_run_with_stream_escapes_terminal_output_only(self) -> None:
        control = chr(27) + "]52;c;VEVTVA==" + chr(7)
        script = (
            "import sys;"
            "value=chr(27)+']52;c;VEVTVA=='+chr(7);"
            "sys.stdout.write(value+'\\n');"
            "sys.stderr.write(value+'\\n')"
        )
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            result = self.helper["run_with_stream"](
                [sys.executable, "-c", script],
                Path.cwd(),
                input_text=None,
                label="stream-test",
                heartbeat_seconds=60,
                stream_display=None,
            )

        self.assertIn(control, result.stdout)
        self.assertIn(control, result.stderr)
        for displayed in (stdout.getvalue(), stderr.getvalue()):
            self.assertNotIn(chr(27), displayed)
            self.assertNotIn(chr(7), displayed)
            self.assertIn(r"\x1b", displayed)
            self.assertIn(r"\x07", displayed)
            self.assertTrue(displayed.endswith("\n"))

    def test_resolve_engine_binary_rejects_codex_no_tools(self) -> None:
        # run_codex() unconditionally refuses --no-tools (see line ~10318);
        # the preflight must report that same rejection instead of reporting
        # codex available just because its binary resolves.
        resolve_engine_binary = self.helper["resolve_engine_binary"]
        reviewer = argparse.Namespace(engine="codex", tools=False, codex_bin="codex")
        available, reason = resolve_engine_binary(reviewer, Path("."))
        self.assertFalse(available)
        self.assertIn("--no-tools", reason)
        self.assertIn("not supported by the Codex engine", reason)

    def test_resolve_engine_binary_checks_path_resolution(self) -> None:
        resolve_engine_binary = self.helper["resolve_engine_binary"]
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            fake_bin_dir = root / "bin"
            fake_bin_dir.mkdir()
            write_executable(
                fake_bin_dir / "codex",
                "#!/usr/bin/env python3\nraise SystemExit(0)\n",
            )
            found = argparse.Namespace(engine="codex", codex_bin="codex")
            with mock.patch.dict(
                os.environ,
                {"PATH": f"{fake_bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"},
            ):
                available, reason = resolve_engine_binary(found, repo)
            self.assertTrue(available, reason)
            self.assertIsNone(reason)

            missing = argparse.Namespace(
                engine="claude",
                claude_bin="definitely-not-a-real-claude-binary",
            )
            available, reason = resolve_engine_binary(missing, repo)
            self.assertFalse(available)
            self.assertIn("executable not found", reason)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_zero_when_bundle_and_engine_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            # Dry run scans the exact prompt too, so use a deterministic
            # scanner instead of relying on the host installation.
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("bundle: constructible", result.stdout)
            self.assertIn("inputs: OK", result.stdout)
            self.assertIn("prompt: OK", result.stdout)
            self.assertIn("OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_rejects_temporary_root_inside_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            repo_temp = repo / "tmp"
            repo_temp.mkdir()
            env.update(
                {
                    "TMPDIR": str(repo_temp),
                    "TEMP": str(repo_temp),
                    "TMP": str(repo_temp),
                }
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("prompt: FAILED", result.stdout)
            self.assertIn("must be outside the reviewed repository", result.stdout)
            self.assertRegex(result.stdout, r"engine check: codex[^\n]* OK\b")

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_trufflehog_missing(self) -> None:
        # Dry run applies the same exact-pack scan as a real provider call.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            env = os.environ.copy()
            env["PATH"] = path_excluding_command("trufflehog")

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("prompt: FAILED", result.stdout)
            self.assertIn("TruffleHog is required but was not found", result.stdout)
            self.assertIn(self.helper["TRUFFLEHOG_INSTALL_URL"], result.stdout)
            # The engine itself still resolves; only trufflehog should fail.
            self.assertRegex(result.stdout, r"engine check: codex[^\n]* OK\b")

    def test_dry_run_flag_exits_nonzero_when_codex_no_tools(self) -> None:
        # run_codex() unconditionally refuses --no-tools; --dry-run must
        # not report codex available just because its binary resolves.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--no-tools",
                    "--dry-run",
                ],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("UNAVAILABLE", result.stdout)
            self.assertIn("--no-tools", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_engine_binary_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "claude",
                    "--claude-bin",
                    "definitely-not-a-real-claude-binary",
                    "--dry-run",
                ],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("UNAVAILABLE", result.stdout)

    def test_dry_run_flag_exits_nonzero_when_bundle_construction_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "commit",
                    "--commit",
                    "no-such-ref-xyz",
                    "--dry-run",
                ],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("bundle: FAILED", result.stdout)

    def test_dry_run_commit_mode_passes_commit_ref_to_prompt_construction(self) -> None:
        # choose_target() always returns target_ref=None for commit mode
        # (see choose_target()); main() derives the real ref by assigning
        # target_ref = args.commit right after commit_bundle() (see main(),
        # just below its commit_bundle() call) before build_review_prompts()
        # runs. dry_run_preflight() must mirror that same assignment so the
        # prompt it validates matches the one a real run would build,
        # instead of validating a prompt with the ref omitted (and
        # potentially under the real byte budget only because of that
        # omission).
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            (repo / "source.txt").write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            git(repo, "commit", "-q", "-m", "seed")
            commit = git(repo, "rev-parse", "HEAD").strip()

            preflight = self.helper["dry_run_preflight"]
            original = preflight.__globals__["build_review_prompts"]
            captured: dict[str, object] = {}

            def capturing(repo_arg, target, target_ref, *rest, **kwargs):
                captured["target_ref"] = target_ref
                return original(repo_arg, target, target_ref, *rest, **kwargs)

            args = argparse.Namespace(
                commit=commit,
                prompt=[],
                prompt_file=[],
                dataset=[],
                max_priority="P0",
            )
            stdout = io.StringIO()
            with mock.patch.dict(
                preflight.__globals__,
                {
                    "build_review_prompts": capturing,
                    "scan_outgoing_review_pack": lambda _repo, _prompt: None,
                },
            ):
                with contextlib.redirect_stdout(stdout):
                    preflight(args, [], repo, "commit", None)

            self.assertEqual(captured.get("target_ref"), commit)
            self.assertIn("prompt: OK", stdout.getvalue())

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_zero_for_plain_commit_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            git(repo, "commit", "-q", "-m", "seed")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "commit",
                    "--commit",
                    "HEAD",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("bundle: constructible", result.stdout)
            self.assertIn("prompt: OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_pi_version_unsupported(self) -> None:
        # run_pi() calls ensure_pi_isolation_supported(), which requires
        # Pi >= 0.79.0 for --no-approve trust isolation before the CLI is
        # ever invoked for a review; --dry-run must reuse that same local
        # --version probe rather than reporting pi available just because
        # the binary resolves on PATH.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            pi_bin = write_executable(
                root / "pi",
                fake_pi_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env["AUTOREVIEW_FAKE_PI_VERSION"] = "0.50.0"

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "pi",
                    "--pi-bin",
                    str(pi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: pi[^\n]* UNAVAILABLE")
            self.assertIn("0.79.0", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_zero_when_pi_version_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            pi_bin = write_executable(
                root / "pi",
                fake_pi_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "pi",
                    "--pi-bin",
                    str(pi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: pi[^\n]* OK\b")

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_kimi_version_unsupported(self) -> None:
        # run_kimi() calls ensure_kimi_isolation_supported(), which requires
        # Kimi Code CLI >= 0.30.0 before the CLI is ever invoked for a
        # review; --dry-run must reuse that same local --version probe
        # rather than reporting kimi available just because the binary
        # resolves on PATH.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env["AUTOREVIEW_FAKE_KIMI_VERSION"] = "0.10.0"

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* UNAVAILABLE")
            self.assertIn("0.30.0", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_zero_when_kimi_version_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            # Isolate KIMI_CODE_HOME to an empty, hermetic directory instead
            # of leaking the host's real ~/.kimi-code (which may or may not
            # exist) into this test; an empty source share has no
            # device_id/credentials to validate and must still report OK.
            env["KIMI_CODE_HOME"] = str(root / "kimi-empty-home")
            (root / "kimi-empty-home").mkdir()

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* OK\b")

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_kimi_config_repo_controlled(self) -> None:
        # run_kimi() calls load_kimi_review_config() before the CLI is ever
        # invoked for a review, and that rejects a KIMI_CODE_HOME pointed
        # inside the reviewed repository (see kimi_source_share); --dry-run
        # must reuse that same local config load rather than reporting kimi
        # available just because the CLI binary and version resolved.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env["KIMI_CODE_HOME"] = str(repo / ".kimi-code")

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* UNAVAILABLE")
            self.assertIn(
                "Kimi configuration must be outside the reviewed repository",
                result.stdout,
            )
            # The bundle, inputs, and prompt assembly still resolve; only the
            # Kimi-specific config load fails.
            self.assertIn("prompt: OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_kimi_device_id_invalid(self) -> None:
        # run_kimi() calls prepare_kimi_runtime_auth() after
        # load_kimi_review_config() and before the CLI is ever invoked for
        # a review; that raises on a device_id that fails the safe-to-stage
        # format check (see validate_kimi_runtime_auth_sources). --dry-run
        # must reuse that same non-mutating check rather than reporting
        # kimi available just because the CLI binary, version, and config
        # load resolved.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            source_share = root / "kimi-home"
            source_share.mkdir()
            (source_share / "device_id").write_text("not-a-valid-id!!", encoding="utf-8")
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env["KIMI_CODE_HOME"] = str(source_share)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* UNAVAILABLE")
            self.assertIn(
                "Kimi device identity is not safe to stage for review",
                result.stdout,
            )
            # The bundle, inputs, and prompt assembly still resolve; only the
            # Kimi-specific auth source check fails.
            self.assertIn("prompt: OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_kimi_credentials_not_a_directory(self) -> None:
        # Same raising check as above (see
        # validate_kimi_runtime_auth_sources), triggered instead by a
        # credentials path that resolves to a file rather than a directory
        # -- the same shape of error a real run's prepare_kimi_runtime_auth()
        # would raise on before ever invoking the CLI.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            source_share = root / "kimi-home"
            source_share.mkdir()
            (source_share / "credentials").write_text("not-a-directory", encoding="utf-8")
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env["KIMI_CODE_HOME"] = str(source_share)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* UNAVAILABLE")
            self.assertIn(
                "Kimi OAuth credentials must be an external directory outside the reviewed repository",
                result.stdout,
            )
            self.assertIn("prompt: OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_zero_when_kimi_auth_sources_valid(self) -> None:
        # A validly staged device_id and OAuth credentials directory (the
        # shape prepare_kimi_runtime_auth() accepts and stages for a real
        # run) must still report kimi OK under --dry-run.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            source_share = root / "kimi-home"
            source_share.mkdir()
            (source_share / "device_id").write_text(
                "0123456789abcdef0123456789abcdef", encoding="utf-8"
            )
            (source_share / "credentials").mkdir()
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            env["KIMI_CODE_HOME"] = str(source_share)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* OK\b")

    def test_dry_run_flag_exits_nonzero_when_claude_tool_not_read_only(self) -> None:
        # run_claude() computes its --tools inventory via
        # claude_allowed_tools()/claude_tool_inventory() before the CLI is
        # ever invoked for a review, and that raises when a configured
        # --claude-allowed-tools rule is not one of the read-only tools
        # (see claude_tool_inventory); --dry-run must reuse that same
        # pure, non-mutating computation rather than reporting claude
        # available just because the CLI binary, version, and isolation
        # flags resolved.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            claude_bin = write_executable(
                root / "claude",
                fake_claude_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "claude",
                    "--claude-bin",
                    str(claude_bin),
                    "--claude-allowed-tools",
                    "Bash",
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"engine check: claude[^\n]* UNAVAILABLE")
            self.assertIn("Claude review tool is not read-only: Bash", result.stdout)
            self.assertIn("prompt: OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_prompt_unpartitionable(self) -> None:
        # The real run does not stop at load_extra_prompt()'s per-file
        # checks: main() also builds the final prompt(s) via
        # build_review_prompts() and rejects context that cannot fit the
        # aggregate prompt budget even after partitioning (see
        # build_review_prompts's "leave too little room for change chunks"
        # branch). Use the Kimi engine's smaller aggregate budget
        # (KIMI_MAX_PROMPT_BYTES) so a single --prompt-file well under the
        # per-file 180000-byte scan cap (MAX_BUNDLE_TEXT_BYTES) still blows
        # the aggregate limit; --dry-run must reuse that same check instead
        # of reporting readiness for a prompt the real run would refuse.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            kimi_bin = write_executable(
                root / "kimi",
                fake_kimi_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)
            prompt_file = repo / "big-prompt.md"
            prompt_file.write_text(
                "context line filler text here\n" * 5_000,
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "kimi",
                    "--kimi-bin",
                    str(kimi_bin),
                    "--prompt-file",
                    "big-prompt.md",
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("prompt: FAILED", result.stdout)
            self.assertIn("too little room", result.stdout)
            # The bundle, inputs, and engine still resolve; only the
            # assembled-prompt aggregate check fails.
            self.assertIn("bundle: constructible", result.stdout)
            self.assertIn("inputs: OK", result.stdout)
            self.assertRegex(result.stdout, r"engine check: kimi[^\n]* OK\b")

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_prompt_file_missing(self) -> None:
        # The real run loads --prompt-file via load_extra_prompt() before
        # ever contacting an engine (see main_impl just after
        # dry_run_preflight returns); --dry-run must reuse that same
        # validation instead of reporting readiness for an input that
        # would fail before an engine starts.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--prompt-file",
                    "missing.md",
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("inputs: FAILED", result.stdout)
            self.assertIn("missing.md", result.stdout)
            # The bundle and engine still resolve; only the input fails.
            self.assertIn("bundle: constructible", result.stdout)
            self.assertRegex(result.stdout, r"engine check: codex[^\n]* OK\b")

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_zero_when_prompt_file_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            prompt_file = repo / "prompt.md"
            prompt_file.write_text("Focus on error handling.\n", encoding="utf-8")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--prompt-file",
                    "prompt.md",
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("inputs: OK", result.stdout)

    @unittest.skipIf(os.name == "nt", "the fake executable is POSIX-only")
    def test_dry_run_flag_exits_nonzero_when_dataset_missing(self) -> None:
        # load_datasets() shares validate_evidence_file() with
        # load_extra_prompt(); confirm --dataset gets the same pre-engine
        # existence check as --prompt-file.
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = init_repo(root)
            source = repo / "source.txt"
            source.write_text("staged\n", encoding="utf-8")
            git(repo, "add", "source.txt")
            codex_bin = write_executable(
                root / "codex",
                fake_codex_script(),
            )
            env = os.environ.copy()
            add_fake_trufflehog(self.helper, root, env)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "local",
                    "--engine",
                    "codex",
                    "--codex-bin",
                    str(codex_bin),
                    "--dataset",
                    "missing-dataset.json",
                    "--dry-run",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("inputs: FAILED", result.stdout)
            self.assertIn("missing-dataset.json", result.stdout)

if __name__ == "__main__":
    unittest.main()
