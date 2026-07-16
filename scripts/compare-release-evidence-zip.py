#!/usr/bin/env python3
import hashlib
import stat
import sys
import zipfile
from pathlib import PurePosixPath

MAX_ENTRIES = 4096
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024


def archive_tree(path: str) -> dict[str, tuple[int, str]]:
    files: dict[str, tuple[int, str]] = {}
    total_bytes = 0
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ValueError("too many dependency evidence archive entries")
        seen: set[str] = set()
        for info in infos:
            name = info.filename
            pure = PurePosixPath(name)
            normalized = str(pure) + ("/" if info.is_dir() else "")
            if (
                not name
                or "\\" in name
                or name != normalized
                or len(pure.parts) < 2
                or pure.parts[0] != "dependency-evidence"
                or any(part in (".", "..") for part in pure.parts)
                or name in seen
            ):
                raise ValueError(f"unsafe dependency evidence archive entry: {name!r}")
            seen.add(name)
            file_type = stat.S_IFMT(info.external_attr >> 16)
            allowed_types = (0, stat.S_IFDIR) if info.is_dir() else (0, stat.S_IFREG)
            if file_type not in allowed_types or info.flag_bits & 0x1:
                raise ValueError(f"unsupported dependency evidence archive entry: {name!r}")
            if info.is_dir():
                continue
            if info.file_size > MAX_FILE_BYTES:
                raise ValueError(f"oversized dependency evidence archive entry: {name!r}")
            total_bytes += info.file_size
            if total_bytes > MAX_TOTAL_BYTES:
                raise ValueError("dependency evidence archive exceeds the size limit")
            digest = hashlib.sha256()
            with archive.open(info) as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            files[name] = (info.file_size, digest.hexdigest())
    return files


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: compare-release-evidence-zip.py <source.zip> <existing.zip>", file=sys.stderr)
        return 2
    try:
        matches = archive_tree(argv[0]) == archive_tree(argv[1])
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"dependency evidence ZIP comparison failed: {error}", file=sys.stderr)
        return 1
    return 0 if matches else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
