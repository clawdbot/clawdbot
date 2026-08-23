#!/usr/bin/env python3
"""Validate and extract bounded Telegram release candidate archives."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
from typing import BinaryIO


DEFAULT_MAX_ENTRIES = 1_000_000
DEFAULT_MAX_APPARENT_BYTES = 8 * 1024 * 1024 * 1024
DEFAULT_MAX_STREAM_BYTES = 10 * 1024 * 1024 * 1024
DEFAULT_MAX_EXTENSION_BYTES = 1 * 1024 * 1024
DEFAULT_MAX_EXTENSION_TOTAL_BYTES = 1 * 1024 * 1024 * 1024
DEFAULT_MAX_PATH_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_PATH_BYTES = 4096
MAX_ARCHIVE_PATH_COMPONENTS = 256
MAX_EXTENSION_NESTING = 32
STREAM_TAIL_WINDOW_BYTES = 64 * 1024


class ArchiveGuardError(Exception):
    """Raised when a candidate tree or archive violates a safety invariant."""


class ArchiveMetadataBudget:
    def __init__(
        self,
        *,
        max_extension_bytes: int,
        max_extension_total_bytes: int,
        max_extension_headers: int,
    ) -> None:
        self.max_extension_bytes = max_extension_bytes
        self.max_extension_total_bytes = max_extension_total_bytes
        self.max_extension_headers = max_extension_headers
        self.extension_bytes = 0
        self.extension_depth = 0
        self.extension_headers = 0

    def begin_extension(self, kind: str, size: int) -> None:
        if size < 0:
            raise ArchiveGuardError(f"archive {kind} extension has negative size")
        if size > self.max_extension_bytes:
            raise ArchiveGuardError(
                f"archive {kind} extension payload exceeds "
                f"{self.max_extension_bytes} bytes"
            )
        if self.extension_depth >= MAX_EXTENSION_NESTING:
            raise ArchiveGuardError(
                f"archive extension nesting exceeds {MAX_EXTENSION_NESTING}"
            )
        extension_headers = self.extension_headers + 1
        if extension_headers > self.max_extension_headers:
            raise ArchiveGuardError(
                "archive extension header count exceeds "
                f"{self.max_extension_headers}"
            )
        padded_size = ((size + tarfile.BLOCKSIZE - 1) // tarfile.BLOCKSIZE) * (
            tarfile.BLOCKSIZE
        )
        total = self.extension_bytes + padded_size
        if total > self.max_extension_total_bytes:
            raise ArchiveGuardError(
                "archive extension payload total exceeds "
                f"{self.max_extension_total_bytes} bytes"
            )
        self.extension_bytes = total
        self.extension_depth += 1
        self.extension_headers = extension_headers

    def end_extension(self) -> None:
        self.extension_depth -= 1


class ArchivePathBudget:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.bytes_used = 0

    def consume(self, value: str, kind: str) -> bytes:
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ArchiveGuardError(f"{kind} is not valid UTF-8") from error
        encoded_size = len(encoded)
        if encoded_size > MAX_ARCHIVE_PATH_BYTES:
            raise ArchiveGuardError(
                f"{kind} exceeds {MAX_ARCHIVE_PATH_BYTES} bytes"
            )
        component_count = len(value.split("/"))
        if component_count > MAX_ARCHIVE_PATH_COMPONENTS:
            raise ArchiveGuardError(
                f"{kind} exceeds {MAX_ARCHIVE_PATH_COMPONENTS} components"
            )
        total = self.bytes_used + encoded_size
        if total > self.limit:
            raise ArchiveGuardError(
                f"archive path metadata exceeds {self.limit} bytes"
            )
        self.bytes_used = total
        return encoded


def _bounded_tarinfo_type(
    budget: ArchiveMetadataBudget,
) -> type[tarfile.TarInfo]:
    class BoundedTarInfo(tarfile.TarInfo):
        def _proc_member(self, archive: tarfile.TarFile) -> tarfile.TarInfo:
            if self.type == tarfile.XGLTYPE:
                raise ArchiveGuardError("archive has unsupported global PAX header")
            if self.type in (tarfile.XHDTYPE, tarfile.SOLARIS_XHDTYPE):
                kind = "PAX"
            elif self.type in (tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
                kind = "GNU long-name"
            elif self.type == tarfile.GNUTYPE_SPARSE:
                raise ArchiveGuardError("archive has unsupported sparse member")
            else:
                return super()._proc_member(archive)

            budget.begin_extension(kind, self.size)
            try:
                return super()._proc_member(archive)
            finally:
                budget.end_extension()

        def _proc_gnusparse_00(self, *_args: object) -> None:
            raise ArchiveGuardError("archive has unsupported sparse member")

        def _proc_gnusparse_01(self, *_args: object) -> None:
            raise ArchiveGuardError("archive has unsupported sparse member")

        def _proc_gnusparse_10(self, *_args: object) -> None:
            raise ArchiveGuardError("archive has unsupported sparse member")

    return BoundedTarInfo


class BoundedReader:
    def __init__(self, source: BinaryIO, limit: int) -> None:
        self.source = source
        self.limit = limit
        self.bytes_read = 0
        self.tail = bytearray()
        self.tail_start = 0
        self.zero_tail_offset: int | None = None
        self.zero_tail_bytes = 0

    def read(self, size: int = -1) -> bytes:
        if size == 0:
            return b""
        remaining = self.limit - self.bytes_read
        request_size = remaining + 1 if size < 0 else min(size, remaining + 1)
        chunk = self.source.read(request_size)
        if self.bytes_read + len(chunk) > self.limit:
            raise ArchiveGuardError(
                f"decompressed archive stream exceeds {self.limit} bytes"
            )
        if self.zero_tail_offset is not None:
            if any(chunk):
                raise ArchiveGuardError("archive has non-zero data after tar end")
            self.zero_tail_bytes += len(chunk)
        self.bytes_read += len(chunk)
        self.tail.extend(chunk)
        if len(self.tail) > STREAM_TAIL_WINDOW_BYTES:
            trim = len(self.tail) - STREAM_TAIL_WINDOW_BYTES
            del self.tail[:trim]
            self.tail_start += trim
        return chunk

    def begin_zero_tail(self, offset: int) -> None:
        if offset < self.tail_start or offset > self.bytes_read:
            raise ArchiveGuardError("cannot validate buffered tar trailer")
        buffered = self.tail[offset - self.tail_start :]
        if any(buffered):
            raise ArchiveGuardError("archive has non-zero data after tar end")
        self.zero_tail_offset = offset
        self.zero_tail_bytes = len(buffered)


def _limit(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"expected an integer, got {value!r}") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("limit must be non-negative")
    return parsed


def _inside_root(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def validate_tree(
    root_value: str | os.PathLike[str],
    *,
    max_entries: int,
    max_apparent_bytes: int,
) -> dict[str, int | str]:
    requested_root = Path(root_value)
    try:
        requested_stat = requested_root.lstat()
        if stat.S_ISLNK(requested_stat.st_mode):
            raise ArchiveGuardError(f"tree root must not be a symlink: {requested_root}")
        root = requested_root.resolve(strict=True)
        root_stat = root.stat()
    except OSError as error:
        raise ArchiveGuardError(
            f"cannot inspect tree root {requested_root}: {error}"
        ) from error
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ArchiveGuardError(f"tree root is not a directory: {root}")

    root_device = root_stat.st_dev
    entries = 0
    apparent_bytes = 0
    pending = [root]
    regular_link_counts: dict[tuple[int, int], tuple[int, int, Path]] = {}

    while pending:
        directory = pending.pop()
        try:
            children = os.scandir(directory)
        except OSError as error:
            raise ArchiveGuardError(f"cannot scan {directory}: {error}") from error

        with children:
            for entry in children:
                path = Path(entry.path)
                try:
                    entry_stat = entry.stat(follow_symlinks=False)
                except OSError as error:
                    raise ArchiveGuardError(f"cannot inspect {path}: {error}") from error

                entries += 1
                if entries > max_entries:
                    raise ArchiveGuardError(
                        f"tree entry count exceeds {max_entries}: {path}"
                    )
                if entry_stat.st_dev != root_device:
                    raise ArchiveGuardError(f"tree entry crosses a device boundary: {path}")

                mode = entry_stat.st_mode
                if stat.S_ISDIR(mode):
                    pending.append(path)
                    continue
                if stat.S_ISREG(mode):
                    apparent_bytes += entry_stat.st_size
                    inode = (entry_stat.st_dev, entry_stat.st_ino)
                    expected_links, observed_links, first_path = regular_link_counts.get(
                        inode, (entry_stat.st_nlink, 0, path)
                    )
                    if expected_links != entry_stat.st_nlink:
                        raise ArchiveGuardError(
                            f"tree hard-link count changed during validation: {path}"
                        )
                    regular_link_counts[inode] = (
                        expected_links,
                        observed_links + 1,
                        first_path,
                    )
                elif stat.S_ISLNK(mode):
                    apparent_bytes += entry_stat.st_size
                    try:
                        target = path.resolve(strict=True)
                    except (OSError, RuntimeError) as error:
                        raise ArchiveGuardError(f"tree has dangling symlink: {path}") from error
                    if not _inside_root(target, root):
                        raise ArchiveGuardError(f"tree has escaping symlink: {path} -> {target}")
                    try:
                        target_stat = target.stat()
                    except OSError as error:
                        raise ArchiveGuardError(
                            f"cannot inspect symlink target {target}: {error}"
                        ) from error
                    if target_stat.st_dev != root_device:
                        raise ArchiveGuardError(
                            f"symlink target crosses a device boundary: {path} -> {target}"
                        )
                elif (
                    stat.S_ISBLK(mode)
                    or stat.S_ISCHR(mode)
                    or stat.S_ISFIFO(mode)
                    or stat.S_ISSOCK(mode)
                ):
                    raise ArchiveGuardError(f"tree has unsupported special entry: {path}")
                else:
                    raise ArchiveGuardError(f"tree has unsupported entry type: {path}")

                if apparent_bytes > max_apparent_bytes:
                    raise ArchiveGuardError(
                        f"tree apparent size exceeds {max_apparent_bytes} bytes: {path}"
                    )

    for expected_links, observed_links, first_path in regular_link_counts.values():
        if observed_links != expected_links:
            raise ArchiveGuardError(
                "tree regular file has hard links outside the validated root: "
                f"{first_path} ({observed_links}/{expected_links} names observed)"
            )

    return {
        "root": str(root),
        "entries": entries,
        "apparentBytes": apparent_bytes,
    }


def _canonical_member_name(name: str) -> str:
    trimmed = name.rstrip("/")
    if not trimmed or "\\" in trimmed or "\0" in trimmed:
        raise ArchiveGuardError(f"archive has invalid path: {name!r}")
    if PurePosixPath(trimmed).is_absolute():
        raise ArchiveGuardError(f"archive has absolute path: {name}")
    parts = trimmed.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ArchiveGuardError(f"archive has non-canonical path: {name}")
    return "/".join(parts)


def _validate_allowed_root(value: str) -> str:
    root = _canonical_member_name(value)
    if "/" in root or root == "manifest.json":
        raise ArchiveGuardError(
            "allowed archive root must be one top-level directory other than manifest.json"
        )
    return root


def _identity_filter(member: tarfile.TarInfo, _destination: str) -> tarfile.TarInfo:
    return member


def _next_stream_member(
    archive: tarfile.TarFile,
) -> tuple[tarfile.TarInfo | None, int]:
    member = archive.next()
    cached_members = len(archive.members)
    archive.members.clear()
    if cached_members > 1:
        raise ArchiveGuardError(
            f"tar metadata cache retained {cached_members} members"
        )
    return member, cached_members


def _destination_member_path(destination: Path, name: str) -> Path:
    return destination.joinpath(*PurePosixPath(name).parts)


def _validate_destination_paths(
    destination: Path,
    name: str,
    *,
    seen_names: set[str],
) -> None:
    parent_name, separator, _member_name = name.rpartition("/")
    if separator:
        if parent_name not in seen_names:
            raise ArchiveGuardError(
                f"archive member parent is not a prior directory: {name}"
            )
        parent_path = _destination_member_path(destination, parent_name)
        try:
            parent_stat = parent_path.lstat()
        except FileNotFoundError as error:
            raise ArchiveGuardError(
                f"archive member parent is not a prior directory: {name}"
            ) from error
        except OSError as error:
            raise ArchiveGuardError(
                f"cannot inspect archive member parent {parent_name}: {error}"
            ) from error
        if not stat.S_ISDIR(parent_stat.st_mode):
            raise ArchiveGuardError(
                f"archive path traverses a non-directory member: {name}"
            )

    member_path = _destination_member_path(destination, name)
    try:
        member_stat = member_path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise ArchiveGuardError(
            f"cannot inspect archive member path {name}: {error}"
        ) from error
    raise ArchiveGuardError(f"archive member collides with an existing path: {name}")


def _extract_link_member(
    member: tarfile.TarInfo,
    *,
    destination: Path,
    name: str,
    hardlink_target: str | None,
) -> None:
    target_path = _destination_member_path(destination, name)
    if os.path.lexists(target_path):
        raise ArchiveGuardError(f"archive link path already exists: {name}")
    try:
        if member.islnk():
            if hardlink_target is None:
                raise ArchiveGuardError(
                    f"archive hard link has no validated target: {name}"
                )
            source_path = _destination_member_path(destination, hardlink_target)
            os.link(source_path, target_path)
        else:
            os.symlink(member.linkname, target_path)
    except OSError as error:
        raise ArchiveGuardError(
            f"cannot extract archive link {name} -> {member.linkname}: {error}"
        ) from error


def _read_process_error(process: subprocess.Popen[bytes]) -> str:
    if process.stderr is None:
        return ""
    return process.stderr.read().decode("utf-8", errors="replace").strip()


def extract_zstd(
    archive_value: str | os.PathLike[str],
    destination_value: str | os.PathLike[str],
    *,
    allowed_root_value: str,
    max_members: int,
    max_expanded_bytes: int,
    max_stream_bytes: int,
    max_extension_bytes: int,
    max_extension_total_bytes: int,
    max_path_bytes: int,
) -> dict[str, int | str]:
    archive_path = Path(archive_value)
    destination = Path(destination_value)
    allowed_root = _validate_allowed_root(allowed_root_value)

    try:
        archive_stat = archive_path.stat()
    except OSError as error:
        raise ArchiveGuardError(
            f"cannot inspect compressed archive {archive_path}: {error}"
        ) from error
    if not stat.S_ISREG(archive_stat.st_mode):
        raise ArchiveGuardError(f"compressed archive is not a regular file: {archive_path}")
    if destination.exists() or destination.is_symlink():
        raise ArchiveGuardError(f"extraction destination must not exist: {destination}")

    destination.mkdir(parents=True, mode=0o700)
    process: subprocess.Popen[bytes] | None = None
    members = 0
    expanded_bytes = 0
    max_cached_members = 0
    seen_names: set[str] = set()
    metadata_budget = ArchiveMetadataBudget(
        max_extension_bytes=max_extension_bytes,
        max_extension_total_bytes=max_extension_total_bytes,
        max_extension_headers=max_members,
    )
    path_budget = ArchivePathBudget(max_path_bytes)
    manifest_seen = False
    root_seen = False

    try:
        process = subprocess.Popen(
            [
                "zstd",
                "--decompress",
                "--stdout",
                "--quiet",
                "--",
                str(archive_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if process.stdout is None:
            raise ArchiveGuardError("zstd did not provide an output stream")
        reader = BoundedReader(process.stdout, max_stream_bytes)

        with tarfile.open(
            fileobj=reader,
            mode="r|",
            bufsize=512,
            tarinfo=_bounded_tarinfo_type(metadata_budget),
        ) as archive:
            while True:
                member, cached_members = _next_stream_member(archive)
                max_cached_members = max(max_cached_members, cached_members)
                if member is None:
                    break
                members += 1
                if members > max_members:
                    raise ArchiveGuardError(
                        f"archive member count exceeds {max_members}: {member.name}"
                    )

                name = _canonical_member_name(member.name)
                path_budget.consume(name, "archive member path")
                if name in seen_names:
                    raise ArchiveGuardError(f"archive has duplicate path: {name}")
                if not (
                    name == "manifest.json"
                    or name == allowed_root
                    or name.startswith(f"{allowed_root}/")
                ):
                    raise ArchiveGuardError(f"archive has unexpected path: {name}")
                _validate_destination_paths(
                    destination,
                    name,
                    seen_names=seen_names,
                )

                if member.size < 0:
                    raise ArchiveGuardError(f"archive member has negative size: {name}")
                if member.issparse():
                    raise ArchiveGuardError(f"archive has unsupported sparse member: {name}")
                expanded_bytes += member.size
                if expanded_bytes > max_expanded_bytes:
                    raise ArchiveGuardError(
                        f"archive expanded size exceeds {max_expanded_bytes} bytes: {name}"
                    )

                is_link = member.issym() or member.islnk()
                hardlink_target: str | None = None
                if member.isdir():
                    if name == "manifest.json":
                        raise ArchiveGuardError("manifest.json must be a regular file")
                elif is_link:
                    if name in {"manifest.json", allowed_root}:
                        raise ArchiveGuardError(
                            f"required archive path cannot be a link: {name}"
                        )
                    path_budget.consume(member.linkname, "archive link target")
                    if member.islnk():
                        target_name = _canonical_member_name(member.linkname)
                        if not target_name.startswith(f"{allowed_root}/"):
                            raise ArchiveGuardError(
                                f"archive hard link target leaves candidate root: "
                                f"{name} -> {member.linkname}"
                            )
                        target_path = _destination_member_path(
                            destination, target_name
                        )
                        try:
                            target_stat = target_path.lstat()
                        except OSError as error:
                            raise ArchiveGuardError(
                                "archive hard link target is not a prior regular "
                                f"file: {name} -> {member.linkname}"
                            ) from error
                        if not stat.S_ISREG(target_stat.st_mode):
                            raise ArchiveGuardError(
                                f"archive hard link target is not a prior regular file: "
                                f"{name} -> {member.linkname}"
                            )
                        hardlink_target = target_name
                elif not member.isreg():
                    raise ArchiveGuardError(
                        f"archive has unsupported member type: {name}"
                    )

                if name == "manifest.json":
                    if not member.isreg():
                        raise ArchiveGuardError("manifest.json must be a regular file")
                    manifest_seen = True
                if name == allowed_root:
                    if not member.isdir():
                        raise ArchiveGuardError(
                            f"archive root must be a directory: {allowed_root}"
                        )
                    root_seen = True

                try:
                    filtered = tarfile.data_filter(member, str(destination))
                except tarfile.FilterError as error:
                    raise ArchiveGuardError(
                        f"archive member is unsafe: {name}: {error}"
                    ) from error
                if filtered is None:
                    raise ArchiveGuardError(f"archive member was rejected: {name}")
                if is_link:
                    _extract_link_member(
                        filtered,
                        destination=destination,
                        name=name,
                        hardlink_target=hardlink_target,
                    )
                else:
                    archive.extract(
                        filtered,
                        path=destination,
                        set_attrs=True,
                        filter=_identity_filter,
                    )
                seen_names.add(name)

            reader.begin_zero_tail(archive.offset)

        while reader.read(1024 * 1024):
            pass
        process.stdout.close()
        process_error = _read_process_error(process)
        return_code = process.wait()
        if return_code != 0:
            detail = f": {process_error}" if process_error else ""
            raise ArchiveGuardError(f"zstd exited with status {return_code}{detail}")
        if reader.zero_tail_bytes < 1024:
            raise ArchiveGuardError("archive is missing the required tar end marker")
        if not manifest_seen:
            raise ArchiveGuardError("archive is missing manifest.json")
        if not root_seen:
            raise ArchiveGuardError(f"archive is missing root directory: {allowed_root}")

        validate_tree(
            destination / allowed_root,
            max_entries=max_members,
            max_apparent_bytes=max_expanded_bytes,
        )
    except BaseException:
        if process is not None and process.poll() is None:
            process.kill()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        elif process is not None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        if process is not None:
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()
            if process.stderr is not None and not process.stderr.closed:
                process.stderr.close()

    return {
        "archive": str(archive_path.resolve()),
        "destination": str(destination.resolve()),
        "allowedRoot": allowed_root,
        "members": members,
        "expandedBytes": expanded_bytes,
        "extensionBytes": metadata_budget.extension_bytes,
        "maxCachedMembers": max_cached_members,
        "pathBytes": path_budget.bytes_used,
        "streamBytes": reader.bytes_read,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate or extract a bounded Telegram release candidate archive."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    validate_parser = commands.add_parser(
        "validate-tree", help="validate an archive source tree"
    )
    validate_parser.add_argument("root")
    validate_parser.add_argument(
        "--max-entries", type=_limit, default=DEFAULT_MAX_ENTRIES
    )
    validate_parser.add_argument(
        "--max-apparent-bytes",
        type=_limit,
        default=DEFAULT_MAX_APPARENT_BYTES,
    )

    extract_parser = commands.add_parser(
        "extract-zstd", help="stream, validate, and extract a .tar.zst archive"
    )
    extract_parser.add_argument("archive")
    extract_parser.add_argument("destination")
    extract_parser.add_argument("--allowed-root", required=True)
    extract_parser.add_argument(
        "--max-members", type=_limit, default=DEFAULT_MAX_ENTRIES
    )
    extract_parser.add_argument(
        "--max-expanded-bytes",
        type=_limit,
        default=DEFAULT_MAX_APPARENT_BYTES,
    )
    extract_parser.add_argument(
        "--max-stream-bytes",
        type=_limit,
        default=DEFAULT_MAX_STREAM_BYTES,
    )
    extract_parser.add_argument(
        "--max-extension-bytes",
        type=_limit,
        default=DEFAULT_MAX_EXTENSION_BYTES,
    )
    extract_parser.add_argument(
        "--max-extension-total-bytes",
        type=_limit,
        default=DEFAULT_MAX_EXTENSION_TOTAL_BYTES,
    )
    extract_parser.add_argument(
        "--max-path-bytes",
        type=_limit,
        default=DEFAULT_MAX_PATH_BYTES,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "validate-tree":
            result = validate_tree(
                args.root,
                max_entries=args.max_entries,
                max_apparent_bytes=args.max_apparent_bytes,
            )
        else:
            result = extract_zstd(
                args.archive,
                args.destination,
                allowed_root_value=args.allowed_root,
                max_members=args.max_members,
                max_expanded_bytes=args.max_expanded_bytes,
                max_stream_bytes=args.max_stream_bytes,
                max_extension_bytes=args.max_extension_bytes,
                max_extension_total_bytes=args.max_extension_total_bytes,
                max_path_bytes=args.max_path_bytes,
            )
    except (ArchiveGuardError, OSError, tarfile.TarError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
