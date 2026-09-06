#!/usr/bin/python3
"""Descriptor-bound native discovery; emit paths only after a complete audit."""
from contextlib import contextmanager
import os
import re
import stat
import subprocess
import sys
from typing import BinaryIO, NamedTuple

# mach-o/{loader,fat}.h: inspect all thin/fat magic byte patterns. On-disk fat
# headers must be big endian; magic alone never establishes a native format.
MACHO_MAGICS = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
)}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
CLASSIFIER_BATCH_SIZE = 64


class NativeInventoryDirectory(NamedTuple):
    parts: tuple[str, ...]
    info: os.stat_result


class NativeInventoryFile(NamedTuple):
    parts: tuple[str, ...]
    info: os.stat_result
    header: bytes
    stream: BinaryIO


class NativeInventorySymlink(NamedTuple):
    parts: tuple[str, ...]
    info: os.stat_result
    target: str


class NativeInventorySpecial(NamedTuple):
    parts: tuple[str, ...]
    info: os.stat_result


def identity(info):
    return info.st_dev, info.st_ino, info.st_mode


def content_identity(info):
    return identity(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns


def read_symlink(name, parent_fd, expected):
    target = os.readlink(name, dir_fd=parent_fd)
    # A rename/restore can preserve inode and mtime while readlink sees another
    # target. Bind the read to metadata including ctime, then validate the literal.
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if content_identity(current) != content_identity(expected):
        raise ValueError(f"Inventory symlink changed: {name}")
    return target


def open_directory(name, parent_fd, expected):
    fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    try:
        if identity(os.fstat(fd)) != identity(expected):
            raise ValueError(f"Inventory directory changed: {name}")
        return fd
    except BaseException:
        os.close(fd)
        raise


class _NativeInventoryTree:
    def __init__(self, root):
        self.root = os.fspath(root).rstrip(os.sep) or os.sep
        info = os.stat(self.root, follow_symlinks=False)
        self._root_fd = open_directory(self.root, None, info)
        self._records = {(): NativeInventoryDirectory((), info)}
        self._iterator = None
        self._complete = False

    def entries(self):
        """Visit once; a regular file's borrowed stream closes on advance or exit."""
        if self._root_fd is None or self._iterator is not None:
            raise ValueError("Native inventory tree is closed or already traversed")
        self._iterator = self._visit(self._root_fd, ())
        return self._iterator

    def _remember(self, entry):
        self._records[entry.parts] = entry
        return entry

    def _visit(self, directory_fd, parts):
        yield self._records[parts]
        with os.scandir(directory_fd) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            child_parts = (*parts, entry.name)
            info = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                target = read_symlink(entry.name, directory_fd, info)
                yield self._remember(NativeInventorySymlink(child_parts, info, target))
            elif stat.S_ISDIR(info.st_mode):
                child_fd = open_directory(entry.name, directory_fd, info)
                self._remember(NativeInventoryDirectory(child_parts, info))
                try:
                    yield from self._visit(child_fd, child_parts)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode):
                fd = os.open(entry.name, FILE_FLAGS, dir_fd=directory_fd)
                with os.fdopen(fd, "rb", buffering=0) as stream:
                    if identity(os.fstat(fd)) != identity(info):
                        raise ValueError(f"Inventory file changed: {entry.name}")
                    # Prepared headers do not consume bytes needed by a copying caller.
                    yield self._remember(NativeInventoryFile(child_parts, info, os.pread(fd, 4, 0), stream))
                    if content_identity(os.fstat(fd)) != content_identity(info):
                        raise ValueError(f"Inventory file changed: {entry.name}")
            else:
                yield self._remember(NativeInventorySpecial(child_parts, info))
        if not parts:
            self._complete = True

    def _validate_root(self):
        if self._root_fd is None:
            raise ValueError("Native inventory tree is closed")
        checked_root = open_directory(self.root, None, self._records[()].info)
        os.close(checked_root)

    @contextmanager
    def _directory_fd(self, parts):
        fd = os.dup(self._root_fd)
        try:
            for index, name in enumerate(parts, 1):
                child_fd = open_directory(name, fd, self._records[parts[:index]].info)
                os.close(fd)
                fd = child_fd
            yield fd
        finally:
            os.close(fd)

    def lstat_child(self, parent_parts, name):
        """Observe one child using filesystem name equivalence, never following links."""
        if name in ("", ".", "..") or "/" in name or "\0" in name:
            raise ValueError("Inventory child must be one name")
        parent_entry = self._records.get(parent_parts)
        if not isinstance(parent_entry, NativeInventoryDirectory):
            raise ValueError("Inventory parent was not traversed")
        self._validate_root()
        with self._directory_fd(parent_parts) as fd:
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            # A new hardlink can share a retained inode without its name having
            # been inventoried. Do not map a changed namespace by inode alone.
            if content_identity(os.fstat(fd)) != content_identity(parent_entry.info):
                raise ValueError("Inventory parent changed")
            return current

    def validate(self):
        """Audit every observed input after complete traversal, including omissions."""
        self._validate_root()
        if not self._complete:
            raise ValueError("Incomplete native inventory traversal; exhaust entries before validation")
        children = {}
        for entry in self._records.values():
            if entry.parts:
                children.setdefault(entry.parts[:-1], []).append(entry)

        def audit(entry, parent_fd):
            name = entry.parts[-1] if entry.parts else self.root
            if isinstance(entry, NativeInventoryDirectory):
                fd = open_directory(name, parent_fd, entry.info)
                try:
                    for child in children.get(entry.parts, ()):
                        audit(child, fd)
                finally:
                    os.close(fd)
            # One directory FD per depth; check its name AFTER descendants so a
            # retained descriptor cannot hide an ancestor replacement during audit.
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if content_identity(current) != content_identity(entry.info) or (
                isinstance(entry, NativeInventorySymlink)
                and read_symlink(name, parent_fd, current) != entry.target
            ):
                raise ValueError(f"Inventory entry changed: {os.path.join(self.root, *entry.parts)}")

        audit(self._records[()], None)

    def close(self):
        # Closing the owned generator also closes a borrowed stream when a caller
        # breaks early or keeps the iterator after leaving the tree's context.
        try:
            if self._iterator is not None:
                self._iterator.close()
        finally:
            if self._root_fd is not None:
                os.close(self._root_fd)
                self._root_fd = None


@contextmanager
def open_native_inventory_tree(root):
    tree = _NativeInventoryTree(root)
    try:
        yield tree
    finally:
        tree.close()


def classify_macho_candidates(candidates):
    """Classify (borrowed stream, diagnostic name) pairs without consuming bytes.

    Callers prefilter with MACHO_MAGICS. None denotes a resource sealed by its
    container, not a direct signing target. Malformed or mixed headers fail.
    """
    if not candidates:
        return []
    fds = tuple(stream.fileno() for stream, _ in candidates)
    names = {fd: name for fd, (_, name) in zip(fds, candidates)}
    positions = {fd: os.lseek(fd, 0, os.SEEK_CUR) for fd in fds}
    try:
        for fd in fds:
            os.lseek(fd, 0, os.SEEK_SET)
        result = subprocess.run(
            ["/usr/bin/file", "-L", "-E", "-b", "-0", "-0", "--",
             *(f"/dev/fd/{fd}" for fd in fds)],
            pass_fds=fds, stdout=subprocess.PIPE,
        )
        result.check_returncode()
        descriptions = result.stdout.split(b"\0")
        if len(descriptions) != len(candidates) + 1 or descriptions[-1] != b"":
            raise ValueError("Incomplete native classifier output")
        native = {}
        for fd, (_, name), description in zip(fds, candidates, descriptions[:-1]):
            first_line = description.split(b"\n", 1)[0]
            if not first_line or first_line.startswith(b"ERROR:"):
                raise ValueError(f"Native classification failed: {name}")
            # file recognizes Java and other resources, but Darwin file 5.41
            # reports valid fat64 as data. Mach headers resolve that unknown case.
            if first_line.startswith(b"Mach-O") or first_line == b"data":
                native[fd] = set()
        if native:
            for fd in native:
                os.lseek(fd, 0, os.SEEK_SET)
            result = subprocess.run(
                ["/usr/bin/otool", "-arch", "all", "-h", *(f"/dev/fd/{fd}" for fd in native)],
                pass_fds=tuple(native), stdout=subprocess.PIPE,
            )
            result.check_returncode()
            lines = iter(line.strip() for line in result.stdout.splitlines() if line.strip())
            archive = False
            for label in lines:
                container = re.fullmatch(rb"Archive : /dev/fd/(\d+)(?: \(architecture .+\))?", label)
                if container:
                    if int(container[1]) not in native:
                        raise ValueError("Unrecognized native archive output")
                    native[int(container[1])].add(b"resource")
                    archive = True
                    continue
                # Top-level labels can introduce tool errors; parse them rather
                # than swallowing a malformed sibling slice as archive content.
                match = re.match(rb"/dev/fd/(\d+)(?: \(architecture .+\))?:", label)
                # Archive members have Mach headers, but their container is a resource.
                # Keep archive slices distinct so mixed image/archive targets fail.
                if archive and not match:
                    continue
                archive = False
                heading = next(lines, b"")
                columns = next(lines, b"").split()
                values = next(lines, b"").split()
                if not match or int(match[1]) not in native or heading != b"Mach header":
                    raise ValueError("Unrecognized native header output")
                if len(columns) != len(values) or not columns or columns[0] != b"magic" or b"filetype" not in columns:
                    raise ValueError("Incomplete native header output")
                if int(values[0], 0) not in (0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe):
                    raise ValueError("Unrecognized native header magic")
                filetype = int(values[columns.index(b"filetype")], 0)
                # MH_OBJECT/CORE/DYLIB_STUB/DSYM are SDK artifacts, not MachORep
                # signing targets. Other headers still require native signature proof.
                kind = (b"resource" if filetype in (1, 4, 9, 10)
                        else b"executable" if filetype == 2 else b"library")
                native[int(match[1])].add(kind)
            for fd, kinds in native.items():
                if not kinds:
                    raise ValueError(f"Missing native header classification: {names[fd]}")
                # One signing target cannot grant an executable slice's JIT rights
                # to a library slice in the same universal image.
                if len(kinds) != 1:
                    raise ValueError(f"Mixed native executable/library/resource slices: {names[fd]}")
        return [next(iter(native[fd] - {b"resource"}), None) if fd in native else None for fd in fds]
    finally:
        # /dev/fd opens share offsets on Darwin. Copying consumers must see the
        # same stream position after classification, including a failed classifier.
        for fd, position in positions.items():
            os.lseek(fd, position, os.SEEK_SET)


def inventory(root):
    records = []
    candidates = []

    def classify():
        try:
            inputs = [(stream, os.path.join(root, *entry.parts)) for entry, stream in candidates]
            kinds = classify_macho_candidates(inputs)
            records.extend((kind, entry) for (entry, _), kind in zip(candidates, kinds) if kind is not None)
        finally:
            for _, stream in candidates:
                stream.close()
            candidates.clear()

    try:
        with open_native_inventory_tree(root) as tree:
            for entry in tree.entries():
                if isinstance(entry, NativeInventorySymlink):
                    records.append((b"symlink", entry))
                elif isinstance(entry, NativeInventoryFile) and entry.header in MACHO_MAGICS:
                    # A bounded batch owns duplicates; borrowed traversal streams
                    # close as soon as the iterator advances to the next entry.
                    stream = os.fdopen(os.dup(entry.stream.fileno()), "rb", buffering=0)
                    candidates.append((entry, stream))
                    if len(candidates) == CLASSIFIER_BATCH_SIZE:
                        classify()
            classify()
            tree.validate()
            return b"".join(
                kind + b"\0" + os.fsencode(os.path.join(root, *entry.parts)) + b"\0"
                for kind, entry in records
            )
    finally:
        for _, stream in candidates:
            stream.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: mac-native-inventory.py <root>")
    sys.stdout.buffer.write(inventory(sys.argv[1]))
