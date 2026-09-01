#!/usr/bin/env python3
"""Carry verified input mtimes in the macOS CI Swift build-cache artifact."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


# These are the input trees/manifests previously handled by the workflow's
# timestamp step. Never follow source links or replay paths supplied by a cache.
INPUT_TREES = (
    "apps/macos/Sources", "apps/macos/Tests", "apps/shared/OpenClawKit/Sources",
    "apps/swabble/Sources", "apps/macos/.build/checkouts",
)
INPUT_FILES = (
    "apps/macos/Package.swift", "apps/macos/Package.resolved",
    "apps/shared/OpenClawKit/Package.swift", "apps/swabble/Package.swift",
)
CACHE_DIRECTORY = "apps/macos/.build"
METADATA_NAME = "ci-input-metadata.json"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


@contextmanager
def open_path(root_fd, relative, flags):
    parent_fd = os.dup(root_fd)
    try:
        parts = relative.split("/")
        for part in parts[:-1]:
            child_fd = os.open(part, DIRECTORY_FLAGS, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = child_fd
        fd = os.open(parts[-1], flags, dir_fd=parent_fd)
        try:
            yield fd
        finally:
            os.close(fd)
    finally:
        os.close(parent_fd)


def input_files(root_fd):
    for tree in INPUT_TREES:
        try:
            with open_path(root_fd, tree, DIRECTORY_FLAGS) as tree_fd:
                for directory, _, names, directory_fd in os.fwalk(
                    ".", dir_fd=tree_fd, follow_symlinks=False,
                ):
                    for name in sorted(names):
                        relative = (Path(tree) / directory / name).as_posix()
                        try:
                            fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
                        except OSError:
                            continue
                        try:
                            yield relative, fd
                        finally:
                            os.close(fd)
        except (FileNotFoundError, NotADirectoryError):
            continue
    for relative in INPUT_FILES:
        try:
            with open_path(root_fd, relative, FILE_FLAGS) as fd:
                yield relative, fd
        except OSError:
            continue


def content_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_metadata(cache_fd):
    try:
        fd = os.open(METADATA_NAME, FILE_FLAGS, dir_fd=cache_fd)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 16 * 1024 * 1024:
                return {}
            metadata = json.load(source)
        if (not isinstance(metadata, dict) or type(metadata.get("version")) is not int
                or metadata["version"] != 1 or not isinstance(metadata.get("files"), dict)):
            return {}
        return metadata["files"]
    except (OSError, ValueError, UnicodeError, RecursionError):
        return {}


def valid_entry(entry):
    return (isinstance(entry, dict) and isinstance(entry.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) is not None
            and type(entry.get("mode")) is int and 0 <= entry["mode"] <= 0o7777
            and type(entry.get("mtime_ns")) is int and 0 <= entry["mtime_ns"] < 2**63)


def run(mode):
    root_fd = os.open(Path.cwd().resolve(), DIRECTORY_FLAGS)
    try:
        with open_path(root_fd, CACHE_DIRECTORY, DIRECTORY_FLAGS) as cache_fd:
            recorded = read_metadata(cache_fd) if mode == "restore" else {}
            if mode == "restore" and not recorded:
                print("[swift-build-cache] restore: no valid input metadata")
                return
            files = {}
            restored = 0
            for relative, fd in input_files(root_fd):
                expected = recorded.get(relative)
                if mode == "restore" and not valid_entry(expected):
                    continue
                before = os.fstat(fd)
                # A hardlink's timestamp is shared with its other names, which
                # may lie outside this checkout. Such files invalidate normally.
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    continue
                digest = hashlib.sha256()
                while chunk := os.read(fd, 1024 * 1024):
                    digest.update(chunk)
                after = os.fstat(fd)
                if content_identity(before) != content_identity(after):
                    raise RuntimeError(f"Swift cache input changed while hashing: {relative}")
                entry = {"sha256": digest.hexdigest(), "mode": stat.S_IMODE(before.st_mode),
                         "mtime_ns": before.st_mtime_ns}
                if mode == "record":
                    files[relative] = entry
                else:
                    if expected["sha256"] == entry["sha256"] and expected["mode"] == entry["mode"]:
                        # Use the verified open file, not a path that could have
                        # become a symlink between hashing and timestamp replay.
                        os.utime(fd, ns=(after.st_atime_ns, expected["mtime_ns"]))
                        restored += 1
            if mode == "record":
                temporary = f".{METADATA_NAME}-{uuid.uuid4().hex}"
                try:
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                 0o644, dir_fd=cache_fd)
                    with os.fdopen(fd, "w", encoding="utf-8") as destination:
                        json.dump({"version": 1, "files": files}, destination, sort_keys=True)
                        destination.write("\n")
                    os.replace(temporary, METADATA_NAME, src_dir_fd=cache_fd, dst_dir_fd=cache_fd)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=cache_fd)
                    except FileNotFoundError:
                        pass
            count = len(files) if mode == "record" else restored
            print(f"[swift-build-cache] {mode}: {count} verified input timestamps")
    except (FileNotFoundError, NotADirectoryError):
        if mode == "record":
            raise
        print("[swift-build-cache] restore: no build-cache metadata")
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("record", "restore"):
        raise SystemExit("Usage: swift-build-cache-metadata.py <record|restore>")
    run(sys.argv[1])
