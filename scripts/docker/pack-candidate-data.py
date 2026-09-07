#!/usr/bin/env python3
"""Trusted data handling for the isolated candidate packer; never runs source code."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile


MANIFEST = "prepublish-plugin-registry.json"
HARNESS_FILES = (
    "scripts/docker/pack-candidate-data.py",
    "scripts/install-smoke-candidate-payload.mts",
    "scripts/prepublish-plugin-registry-artifact.mjs",
    "scripts/package-source-preflight.mjs",
    "scripts/package-source-dependencies.mjs",
    "scripts/package-changelog.mjs",
    "scripts/lib/release-notes-compaction.mjs",
)


def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def regular(file):
    if not stat.S_ISREG(file.lstat().st_mode):
        raise ValueError(f"expected a regular file: {file.name}")


def empty_directory(directory):
    if directory.is_symlink():
        raise ValueError("output directory must not be a symlink")
    directory.mkdir(mode=0o750, parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError("output directory must be empty")


def prepare(args):
    if args.registry_output_dir:
        # Match the existing producer's option rules; it still owns manifest validation.
        names = json.loads(args.required_packages_json)
        pattern = r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*"
        if not isinstance(names, list) or any(
            not isinstance(name, str) or not re.fullmatch(pattern, name) for name in names
        ):
            raise ValueError("required packages must be an array of npm package names")
        if len(set(names)) != len(names):
            raise ValueError("required packages must not contain duplicates")
        if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+-]*", args.candidate_version):
            raise ValueError("candidate version must be a package version")
    paths = [
        Path(value)
        for value in (args.archive, args.harness_dir, args.scratch, args.output_dir,
                      args.registry_output_dir)
        if value
    ]
    if any(item.is_symlink() for item in paths):
        raise ValueError("candidate input/output paths must not be symlinks")
    resolved = [item.resolve() for item in paths]
    for index, first in enumerate(resolved):
        for second in resolved[index + 1:]:
            if first == second or first in second.parents or second in first.parents:
                raise ValueError("candidate input, harness, scratch and outputs must be disjoint")
    for value in (args.output_dir, args.registry_output_dir):
        if value:
            empty_directory(Path(value))
    harness = Path(args.harness_dir).resolve()
    snapshot = Path(args.scratch) / "harness"
    for name in HARNESS_FILES:
        source = harness / name
        regular(source)
        if source.resolve() != source:
            raise ValueError(f"trusted harness file must not traverse a symlink: {name}")
        target = snapshot / name
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        with source.open("rb") as src, target.open("xb") as dst:
            shutil.copyfileobj(src, dst)
        target.chmod(0o644)


def archive_inventory(archive):
    entries = {}
    seen = set()
    roots = set()
    with tarfile.open(archive, "r:*") as source:
        for member in source:
            name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
            parts = name.split("/")
            if any(part in ("", ".", "..") or part.lower() == ".git" for part in parts):
                raise ValueError("unsafe source archive path or embedded Git metadata")
            roots.add(parts[0])
            name = "/".join(parts[1:])
            if name in seen:
                raise ValueError("duplicate source archive path")
            seen.add(name)
            if not name:
                if not member.isdir():
                    raise ValueError("source archive must have one directory root")
                continue
            if member.isdir():
                value = ("directory",)
            elif member.isfile():
                with source.extractfile(member) as stream:
                    value = ("file", bool(member.mode & 0o111), digest(stream))
            elif member.issym():
                target = posixpath.normpath(
                    posixpath.join(posixpath.dirname(name), member.linkname)
                )
                if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
                    raise ValueError("source archive symlink escapes its root")
                value = ("symlink", os.fsencode(member.linkname))
            else:
                raise ValueError("unsupported source archive member type")
            entries[name] = value
        if len(roots) != 1:
            raise ValueError("source archive must have one directory root")
    for name in list(entries):
        for parent in Path(name).parents:
            if str(parent) == ".":
                continue
            key = parent.as_posix()
            if key in entries and entries[key] != ("directory",):
                raise ValueError("source archive path descends through a non-directory")
            entries[key] = ("directory",)
    return entries


def compare(args):
    root = Path(args.source_dir)
    head = subprocess.check_output(
        ["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=root, text=True
    ).strip()
    if head != args.target_sha:
        raise ValueError("repository HEAD differs from the requested artifact source SHA")
    try:
        subprocess.run(["git", "diff", "--cached", "--quiet", "HEAD", "--"], cwd=root, check=True)
        subprocess.run(["git", "diff", "--quiet", "--"], cwd=root, check=True)
    except subprocess.CalledProcessError as error:
        if error.returncode == 1:
            raise ValueError("repository has tracked changes before candidate execution") from error
        raise
    # Git's NUL-delimited tree format identifies unsupported gitlinks without tar text parsing.
    tree = subprocess.check_output(["git", "ls-tree", "-rz", "--full-tree", "HEAD"], cwd=root)
    if any(entry.startswith(b"160000 ") for entry in tree.split(b"\0")):
        raise ValueError("unsupported archive/checkout equivalence: submodule entries")
    expected = archive_inventory(args.archive)
    actual = {}
    pending = [root]
    while pending:
        directory = pending.pop()
        for entry in directory.iterdir():
            name = entry.relative_to(root).as_posix()
            if name == ".git":
                continue
            mode = entry.lstat().st_mode
            if stat.S_ISDIR(mode):
                actual[name] = ("directory",)
                pending.append(entry)
            elif stat.S_ISREG(mode):
                with entry.open("rb") as stream:
                    actual[name] = ("file", bool(mode & 0o111), digest(stream))
            elif stat.S_ISLNK(mode):
                actual[name] = ("symlink", os.fsencode(os.readlink(entry)))
            else:
                raise ValueError("unsupported source checkout member type")
    if expected != actual:
        raise ValueError(
            "source archive differs from checkout; unsupported export/checkout "
            "representation or source mismatch"
        )
    manifest = root / "package.json"
    regular(manifest)
    if json.loads(manifest.read_text())["version"] != args.candidate_version:
        raise ValueError("root package version differs from the requested candidate version")


def node_result(harness, script, arguments):
    return subprocess.check_output(
        ["node", str(Path(harness) / "scripts" / script), *arguments], text=True
    )


def seal_registry(args):
    raw = Path(args.registry_dir)
    if raw.is_symlink() or not raw.is_dir():
        raise ValueError("raw registry must be a directory, not a symlink")
    files = list(raw.iterdir())
    for file in files:
        regular(file)
    manifest = raw / MANIFEST
    regular(manifest)
    with manifest.open("rb") as stream:
        manifest_sha = digest(stream)
    common = [
        "--source-sha", args.target_sha, "--candidate-version", args.candidate_version,
        "--manifest-sha256", manifest_sha, "--required-packages-json", args.required_packages_json,
    ]
    node_result(args.harness_dir, "prepublish-plugin-registry-artifact.mjs",
                ["verify", "--artifact-dir", str(raw), *common])
    output = Path(args.registry_output_dir)
    empty_directory(output)
    for file in files:
        with file.open("rb") as src, (output / file.name).open("xb") as dst:
            shutil.copyfileobj(src, dst)
    result = json.loads(node_result(
        args.harness_dir, "prepublish-plugin-registry-artifact.mjs",
        ["verify", "--artifact-dir", str(output), *common],
    ))
    result["manifestPath"] = str(Path(args.reported_registry_dir) / MANIFEST)
    return json.dumps(result) + "\n"


def seal(args):
    registry_result = seal_registry(args) if args.registry_output_dir else None
    if args.mode == "registry-only":
        return registry_result
    result = node_result(args.harness_dir, "install-smoke-candidate-payload.mts", [
        "seal", "--archive", args.archive, "--package-dir", args.package_dir,
        "--output-dir", args.output_dir, "--repository", args.repository,
        "--target-sha", args.target_sha, "--harness-repository", args.harness_repository,
        "--harness-sha", args.harness_sha, "--run-id", args.run_id,
        "--run-attempt", args.run_attempt,
    ])
    if registry_result and json.loads(result)["packageVersion"] != args.candidate_version:
        raise ValueError("sealed root package version differs from the requested candidate version")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "compare", "seal"))
    for name in (
        "archive", "harness-dir", "scratch", "source-dir", "output-dir", "package-dir",
        "registry-dir", "registry-output-dir", "reported-registry-dir", "candidate-version",
        "required-packages-json", "repository", "target-sha", "harness-repository",
        "harness-sha", "run-id", "run-attempt",
    ):
        parser.add_argument("--" + name, default="")
    parser.add_argument("--mode", choices=("package", "registry-only"), default="package")
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise ValueError("candidate data handling requires a non-root user")
    result = {"prepare": prepare, "compare": compare, "seal": seal}[args.command](args)
    if result is not None:
        sys.stdout.write(result)


if __name__ == "__main__":
    try:
        main()
    except (
        OSError, ValueError, KeyError, tarfile.TarError, subprocess.CalledProcessError
    ) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
