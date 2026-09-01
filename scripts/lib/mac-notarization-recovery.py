#!/usr/bin/env python3
"""Bind a retained macOS release checkpoint to its source and artifact bytes."""

import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import sys
import zipfile


FILES = {
    "app.zip", "symbols.zip", "app.dmg", "app-submission.json",
    "dmg-submission.json", "sparkle-tools.zip",
}


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def inventory(root):
    result = {}
    for path in root.iterdir():
        if path.name in {"manifest.json", "workflow-release.json"}:
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"Unexpected recovery artifact: {path.name}")
            continue
        if path.name not in FILES or path.is_symlink() or not path.is_file():
            raise ValueError(f"Unexpected recovery artifact: {path.name}")
        result[path.name] = digest(path)
    return result


def verify_app_archive(path):
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            parts = item.filename.rstrip("/").split("/")
            if parts[0] not in {"OpenClaw.app", "__MACOSX"} or ".." in parts:
                raise ValueError("Recovery app archive contains an unsafe path")
            if stat.S_ISLNK(item.external_attr >> 16):
                if item.file_size > 4096:
                    raise ValueError("Recovery app archive contains an oversized symlink")
                target = archive.read(item).decode("utf-8")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(item.filename), target))
                if not resolved.startswith("OpenClaw.app/"):
                    raise ValueError("Recovery app symlink escapes its bundle")


def main():
    command, directory, *args = sys.argv[1:]
    root = Path(directory)
    manifest = root / "manifest.json"
    if root.is_symlink() or manifest.is_symlink():
        raise ValueError("Recovery paths must not be symlinks")
    if command == "init":
        source, version, build, skip_dmg, skip_dsym = args
        data = dict(schemaVersion=1, sourceSha=source, version=version, build=build,
                    skipDmg=skip_dmg == "1", skipDsym=skip_dsym == "1", completed=False)
    else:
        data = json.loads(manifest.read_text())
    if (data.get("schemaVersion") != 1
            or not re.fullmatch(r"[0-9a-f]{40}", data.get("sourceSha", ""))
            or not re.fullmatch(r"[0-9]+", data.get("build", ""))
            or not isinstance(data.get("version"), str)
            or type(data.get("skipDmg")) is not bool
            or type(data.get("skipDsym")) is not bool
            or type(data.get("completed")) is not bool):
        raise ValueError("Invalid recovery manifest identity")
    files = inventory(root)
    if "app.zip" not in files or (not data["skipDsym"] and "symbols.zip" not in files):
        raise ValueError("Recovery checkpoint lacks signed app or symbols")
    if command in {"verify", "retire-completed"}:
        if command == "verify":
            source, version = args
            if data["sourceSha"] != source or data["version"] != version:
                raise ValueError("Recovery checkpoint does not match selected release source/version")
        elif args:
            raise ValueError("retire-completed does not accept extra arguments")
        if files != data.get("files"):
            raise ValueError("Recovery artifact inventory or SHA-256 mismatch")
        verify_app_archive(root / "app.zip")
        if command == "verify":
            print(json.dumps(data))
            return
        if not data["completed"]:
            raise ValueError("Recovery checkpoint is incomplete; resume notarization before packaging again")
        # Delete only the validated inventory; unexpected additions make rmdir fail closed.
        for name in [*files, "workflow-release.json", "manifest.json"]:
            (root / name).unlink(missing_ok=True)
        root.rmdir()
        return
    if command not in {"init", "seal", "complete"} or (command != "init" and args):
        raise ValueError("Expected init, seal, complete, verify, or retire-completed")
    if command == "complete":
        verify_app_archive(root / "app.zip")
        data["completed"] = True
    data["files"] = files
    temporary = root / "manifest.json.tmp"
    with temporary.open("w") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, manifest)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        sys.exit(f"macOS notarization recovery: {error}")
