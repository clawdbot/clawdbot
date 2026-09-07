#!/usr/bin/env python3
"""Validate bounded archive entries before exporting regular proof/bundle files."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile
import zipfile

mode, source, destination = sys.argv[1:]
limit = 16 * 1024 * 1024
seen = set()
total = 0

def admit(name, size):
    global total
    if not name or len(name) > 240 or "\\" in name or "\x00" in name or ":" in name:
        raise ValueError("unsafe archive path")
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts) or PurePosixPath(name).is_absolute():
        raise ValueError("unsafe archive path")
    if name in seen or len(seen) >= 4096 or size < 0 or size > limit:
        raise ValueError("duplicate or oversized archive entry")
    seen.add(name)
    total += size
    if total > (256 * 1024 * 1024 if mode == "bundle" else limit):
        raise ValueError("oversized archive")

if mode == "bundle":
    root = Path(destination)
    root.mkdir(mode=0o700)
    with tarfile.open(source, "r:") as archive:
        for entry in archive:
            name = entry.name
            # docker cp wraps the selected directory in one root component.
            if name.startswith("./"):
                name = name[2:]
            if name in (".", "control-ui", "control-ui/") and entry.isdir():
                continue
            if name.startswith("control-ui/"):
                name = name[len("control-ui/"):]
            admit(name, entry.size)
            if entry.isdir():
                (root / name).mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                data = archive.extractfile(entry).read(limit + 1)
                if len(data) != entry.size:
                    raise ValueError("truncated bundle entry")
                with file.open("xb") as output:
                    output.write(data)
            else:
                raise ValueError("bundle links and special files are forbidden")
    if not (root / "index.html").is_file():
        raise ValueError("bundle has no index.html")
    # Exported public UI assets must be readable by the non-root observer,
    # independent of the host umask. They are mounted read-only afterward.
    for directory, _, names in os.walk(root):
        os.chmod(directory, 0o755)
        for name in names:
            os.chmod(Path(directory) / name, 0o444)
elif mode in ("evidence", "telegram-evidence", "telegram-qa-evidence"):
    required = ({"qa-execution.json", "qa-result.json", "qa-observations.json"}
                if mode == "telegram-qa-evidence" else
                {"telegram-send.json", "provider-request.json", "telegram-reply.json"}
                if mode == "telegram-evidence" else
                {"observer.json", "chat-send.json", "final-reply.json", "final-reply.png"})
    files = {}
    diagnostic = {"telegram-failure.json"} if mode == "telegram-evidence" else set()
    with zipfile.ZipFile(source) as archive:
        for entry in archive.infolist():
            name = entry.filename
            if entry.orig_filename != name:
                raise ValueError("noncanonical archive path")
            admit(name, entry.file_size)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if name not in required | diagnostic or kind not in (0, stat.S_IFREG) or entry.is_dir() or entry.flag_bits & 1:
                raise ValueError("unexpected or unsafe evidence entry")
            if name.endswith(".json") and entry.file_size > 65536:
                raise ValueError("oversized evidence JSON")
            if name in diagnostic and entry.file_size > 16384:
                raise ValueError("oversized failure diagnostic")
            with archive.open(entry) as stream:
                data = stream.read(limit + 1)
            if len(data) != entry.file_size:
                raise ValueError("truncated evidence entry")
            files[name] = base64.b64encode(data).decode("ascii")
    if set(files) != required and (not diagnostic or set(files) != diagnostic):
        raise ValueError("incomplete evidence inventory")
    Path(destination).write_text(json.dumps(files), encoding="utf-8")
else:
    raise ValueError("unknown archive mode")
