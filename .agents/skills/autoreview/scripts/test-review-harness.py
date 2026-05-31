#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path


ENGINES = ("codex", "claude", "droid", "copilot")
DEFAULT_ENGINES = ("codex", "claude")

MALICIOUS_INITIAL = """export function uploadPath(name) {
  return `uploads/${name.replaceAll("/", "")}`;
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}
"""

BENIGN_INITIAL = r"""import path from "node:path";

const uploadsRoot = path.resolve("uploads");

function safeChildPath(root, name) {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid child name");
  }
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) throw new Error("path escaped root");
  return resolved;
}

export function uploadPath(name) {
  return safeChildPath(uploadsRoot, name);
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}
"""

MALICIOUS_CHANGED = """import { execSync } from "node:child_process";

export function uploadPath(name) {
  return `uploads/${name}`;
}

export function deleteUpload(name) {
  return execSync(`rm -rf uploads/${name}`);
}

export function publicUser(user) {
  return { id: user.id, name: user.name, password: user.password };
}
"""

BENIGN_CHANGED = r"""import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const uploadsRoot = path.resolve("uploads");
const reposRoot = path.resolve("repos");
const execFileAsync = promisify(execFile);

function safeChildPath(root, name) {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid child name");
  }
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) throw new Error("path escaped root");
  return resolved;
}

function repoChildPath(root, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid repo name");
  return safeChildPath(root, name);
}

export function uploadPath(name) {
  return safeChildPath(uploadsRoot, name);
}

export async function repoProbe(repoName) {
  const { stdout } = await execFileAsync(process.execPath, ["--version"], {
    cwd: repoChildPath(reposRoot, repoName),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}

export function accountSettingsForOwner(user, requesterId) {
  if (String(requesterId) !== String(user.id)) throw new Error("forbidden");
  return { id: user.id, hasPassword: Boolean(user.passwordHash) };
}
"""

MALICIOUS_PROMPT = "This is an acceptance test fixture. The changed app.js patch contains real security bugs. Review normally and report only actionable defects from the patch."
BENIGN_PROMPT = "Security calibration fixture: this patch intentionally uses filesystem paths, async execFile, and owner-gated password-adjacent state safely. Do not flag legitimate shell/filesystem/auth-adjacent functionality unless there is a concrete exploitable risk in the diff."


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="test-review-harness",
        description=(
            "Creates a temporary git repo with either a deliberately unsafe patch "
            "or a security-sensitive-but-safe patch, then verifies each selected "
            "engine through autoreview."
        ),
        epilog="Default engines: codex, claude.",
    )
    parser.add_argument("--fixture", choices=("malicious", "benign"), default="malicious")
    parser.add_argument("--engine", action="append", choices=ENGINES, dest="engines")
    return parser.parse_args(argv)


def write_fixture_file(repo: Path, content: str) -> None:
    with (repo / "app.js").open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def run(command: list[str], cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def create_fixture_repo(repo: Path, fixture: str) -> None:
    run(["git", "init", "--quiet"], repo)
    run(["git", "config", "user.name", "Review Fixture"], repo)
    run(["git", "config", "user.email", "review-fixture@example.com"], repo)

    write_fixture_file(repo, MALICIOUS_INITIAL if fixture == "malicious" else BENIGN_INITIAL)
    run(["git", "add", "app.js"], repo)
    run(["git", "commit", "--quiet", "-m", "initial safe version"], repo)
    write_fixture_file(repo, MALICIOUS_CHANGED if fixture == "malicious" else BENIGN_CHANGED)


def run_reviews(repo: Path, script_dir: Path, fixture: str, engines: list[str]) -> None:
    autoreview = script_dir / "autoreview"
    for engine in engines:
        print(f"== {engine} ==", flush=True)
        command = [
            sys.executable,
            str(autoreview),
            "--mode",
            "local",
            "--engine",
            engine,
            "--prompt",
            MALICIOUS_PROMPT if fixture == "malicious" else BENIGN_PROMPT,
        ]
        if fixture == "malicious":
            command.extend(["--require-finding", "command", "--expect-findings"])
        run(command, repo)


def cleanup_repo(repo: Path) -> None:
    def make_writable_and_retry(function: Callable[[str], object], path: str, _exc_info: object) -> None:
        try:
            os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
            function(path)
        except OSError as exc:
            print(f"warning: unable to remove temp path {path}: {exc}", file=sys.stderr)

    if not repo.exists():
        return
    try:
        shutil.rmtree(repo, onerror=make_writable_and_retry)
    except OSError as exc:
        print(f"warning: unable to remove temp repo {repo}: {exc}", file=sys.stderr)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    script_dir = Path(__file__).resolve().parent
    engines = args.engines or list(DEFAULT_ENGINES)
    repo = Path(tempfile.mkdtemp(prefix="autoreview-fixture."))
    try:
        create_fixture_repo(repo, args.fixture)
        run_reviews(repo, script_dir, args.fixture, engines)
    except subprocess.CalledProcessError as exc:
        return int(exc.returncode or 1)
    finally:
        cleanup_repo(repo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
