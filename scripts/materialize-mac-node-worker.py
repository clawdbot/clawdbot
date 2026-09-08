#!/usr/bin/python3
"""Construct a fresh target-native worker without pruning the installed package."""
from contextlib import ExitStack
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys

spec = importlib.util.spec_from_file_location(
    "mac_native_inventory", os.path.join(os.path.dirname(__file__), "lib/mac-native-inventory.py")
)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

# PE/COFF machine identifiers (winnt.h), including bigobj/import-object headers;
# XCOFF is big endian. Weak prefix hits must not override file's positive text verdict.
COFF_MAGICS = {value.to_bytes(2, "little") for value in (
    0x14c, 0x166, 0x169, 0x184, 0x1a2, 0x1a3, 0x1a6, 0x1a8,
    0x1c0, 0x1c2, 0x1c4, 0x1d3, 0x1f0, 0x1f1, 0x200, 0x266,
    0x366, 0x466, 0x5032, 0x5064, 0x5128, 0x6232, 0x6264,
    0x8664, 0x9041, 0xa641, 0xa64e, 0xaa64, 0xebc,
)} | {b"\x01\xdf", b"\x01\xf7"}


def candidate(header):
    return (header[:4] in native.MACHO_MAGICS or header[:4] in (b"\x7fELF", b"\0\0\xff\xff")
            or header[:2] == b"MZ" or header[:2] in COFF_MAGICS
            or header[:8] in (b"!<arch>\n", b"!<thin>\n"))


def classify(batch, architecture):
    # Inherited /dev/fd names bind tools to the same objects later copied.
    # Darwin dup/dev-fd readers share cursors: rewind before EVERY operation.
    fds = tuple(stream.fileno() for _, stream, _ in batch)
    for _, stream, _ in batch:
        stream.seek(0)
    result = subprocess.run(
        ["/usr/bin/file", "-L", "-E", "-b", "-0", "-0", "--",
         *(f"/dev/fd/{fd}" for fd in fds)],
        pass_fds=fds, stdout=subprocess.PIPE, check=True,
    )
    descriptions = result.stdout.split(b"\0")
    if len(descriptions) != len(batch) + 1 or descriptions[-1] != b"":
        raise ValueError("Incomplete worker file classification")
    for (entry, stream, header), description in zip(batch, descriptions):
        description = description.split(b"\n", 1)[0]
        if not description or re.search(rb"ERROR|cannot (?:read|open)", description, re.I):
            raise ValueError(f"Invalid worker file classification: {entry.parts!r}")
        reason = None
        if header[:4] == b"\xca\xfe\xba\xbe" and description.startswith(b"compiled Java class"):
            pass
        elif header[:4] in native.MACHO_MAGICS or header[:8] in (b"!<arch>\n", b"!<thin>\n"):
            if not (description.startswith(b"Mach-O") or description == b"data" or b"ar archive" in description):
                raise ValueError(f"Unclassified worker native header: {entry.parts!r}")
            stream.seek(0)
            fd_path = f"/dev/fd/{stream.fileno()}"
            info = subprocess.run(
                ["/usr/bin/lipo", "-info", fd_path],
                pass_fds=(stream.fileno(),), stdout=subprocess.PIPE, check=True,
            ).stdout
            # -archs can concatenate fat resource slices; -info separates them.
            # Bind its complete, single-line result to the requested descriptor.
            fd_pattern = re.escape(fd_path.encode())
            match = re.fullmatch(
                rb"(?:Architectures in the fat file: " + fd_pattern +
                rb" are: ([a-zA-Z0-9_]+(?: [a-zA-Z0-9_]+)*) ?|Non-fat file: " +
                fd_pattern + rb" is architecture: ([a-zA-Z0-9_]+))\n", info,
            )
            # lipo can report an unknown CPU with exit 0; it is not an omission verdict.
            if not match or b"unknown" in info:
                raise ValueError(f"Uncertain worker native slices: {entry.parts!r}")
            slices = match[1] or match[2]
            if architecture.encode() not in slices.split():
                reason = f"lacks {architecture} ({slices.decode()})"
        elif re.search(rb"^(?:ELF|PE32|MS-DOS executable)|\b(?:COFF|XCOFF)\b", description):
            minimum = (64 if header[4:5] == b"\x02" else 52) if header[:4] == b"\x7fELF" else (64 if header[:2] == b"MZ" else 20)
            if len(header) < minimum or re.search(rb"invalid|corrupt|truncated|unknown|missing", description, re.I):
                raise ValueError(f"Malformed worker native image: {entry.parts!r}")
            reason = f"not Darwin ({description.decode(errors='replace')})"
        # file trims trailing NULs and guesses unknown 8-bit encodings as text.
        # Neither proves that a binary-prefix candidate is an ordinary resource.
        elif b"\0" in header or not re.search(
            rb"(?:^|, )(?:ASCII|Unicode|ISO-8859|(?:International )?EBCDIC) text\b", description
        ):
            raise ValueError(f"Unclassified worker native header: {entry.parts!r}")
        yield entry, stream, reason


def validate_links(entries, tree):
    """Resolve filesystem-equivalent retained targets, then audit every target edge."""
    children = {parts: set() for parts in entries}
    for parts in entries:
        if parts:
            children[parts[:-1]].add(parts)
    targets = {}
    resolving = set()

    def lookup(parent, name):
        exact = (*parent, name)
        if exact in entries:
            return {exact}
        observed = native.content_identity(tree.lstat_child(parent, name))
        # Existing same-parent hardlinks have identical metadata, but copying
        # splits their output inodes. Retain every equivalent leaf, not one spelling.
        matches = {child for child in children[parent]
                   if native.content_identity(entries[child].info) == observed}
        if not matches:
            raise ValueError(f"Worker symlink has no retained target: {exact!r}")
        return matches

    def resolve_link(parts):
        if parts in resolving:
            raise ValueError(f"Cyclic worker symlink: {parts!r}")
        if parts in targets:
            return targets[parts]
        resolving.add(parts)
        target = entries[parts].target
        if os.path.isabs(target):
            raise ValueError(f"Worker symlink escapes input: {parts!r}")
        resolved = {parts[:-1]}
        for component in target.split("/"):
            following = set()
            for parent in resolved:
                if not isinstance(entries[parent], native.NativeInventoryDirectory):
                    raise ValueError(f"Worker symlink traverses a non-directory: {parts!r}")
                if component == "..":
                    if not parent:
                        raise ValueError(f"Worker symlink escapes input: {parts!r}")
                    following.add(parent[:-1])
                elif component in ("", "."):
                    following.add(parent)
                else:
                    for child in lookup(parent, component):
                        following.update(resolve_link(child) if isinstance(
                            entries[child], native.NativeInventorySymlink) else {child})
            resolved = following
        resolving.remove(parts)
        targets[parts] = resolved
        return resolved

    for parts, entry in entries.items():
        if isinstance(entry, native.NativeInventorySymlink):
            resolve_link(parts)
    visiting, visited = set(), set()

    def visit(parts):
        if parts in visiting:
            raise ValueError(f"Cyclic worker tree: {parts!r}")
        if parts in visited:
            return
        visiting.add(parts)
        for child in targets.get(parts, children[parts]):
            visit(child)
        visiting.remove(parts)
        visited.add(parts)

    visit(())
    return targets


def materialize(source, destination, parent, architecture):
    source = os.path.abspath(source)
    source = os.path.join(os.path.realpath(os.path.dirname(source)), os.path.basename(source))
    parent_path = os.path.abspath(parent)
    parent = os.path.realpath(parent_path)
    destination = os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(destination))),
                               os.path.basename(destination))
    if (not stat.S_ISDIR(os.lstat(parent_path).st_mode)
            or os.path.dirname(destination) != parent
            or os.path.commonpath((source, destination)) in (source, destination)):
        raise ValueError("Worker output must be disjoint from input and directly inside its staging parent")

    entries, directories, batch = {}, [], []
    retained_files = omitted = 0

    def copy(entry, stream):
        nonlocal retained_files
        stream.seek(0)
        with open(os.path.join(destination, *entry.parts), "xb") as output:
            shutil.copyfileobj(stream, output)
            if output.tell() != entry.info.st_size:
                raise ValueError(f"Short worker copy: {entry.parts!r}")
            # Darwin writes clear setuid; drain buffered bytes before restoring mode.
            output.flush()
            os.fchmod(output.fileno(), stat.S_IMODE(entry.info.st_mode))
        retained_files += 1

    def flush():
        nonlocal omitted
        for entry, stream, reason in classify(batch, architecture) if batch else ():
            if reason is None:
                copy(entry, stream)
            else:
                del entries[entry.parts]
                omitted += 1
                if omitted <= 40:
                    print(f"Omitting native {json.dumps('/'.join(entry.parts))}: {reason[:240]}", file=sys.stderr)
        handles.close()
        batch.clear()

    # The build owns the private staging parent exclusively until return. Source
    # substitution is untrusted; concurrent writers to output/parent are not supported.
    # mkdir claims only a fresh output; cleanup never removes an existing occupant.
    os.mkdir(destination, 0o700)
    directories.append(destination)
    try:
        with ExitStack() as handles, native.open_native_inventory_tree(source) as tree:
            for entry in tree.entries():
                entries[entry.parts] = entry
                output = os.path.join(destination, *entry.parts)
                if isinstance(entry, native.NativeInventoryDirectory):
                    if entry.parts:
                        os.mkdir(output, 0o700)
                        directories.append(output)
                elif isinstance(entry, native.NativeInventoryFile):
                    header = os.pread(entry.stream.fileno(), 64, 0)
                    if candidate(header):
                        stream = handles.enter_context(os.fdopen(os.dup(entry.stream.fileno()), "rb", buffering=0))
                        batch.append((entry, stream, header))
                        if len(batch) == native.CLASSIFIER_BATCH_SIZE:
                            flush()
                    else:
                        copy(entry, entry.stream)
                elif isinstance(entry, native.NativeInventorySpecial):
                    raise ValueError(f"Unsupported worker filesystem entry: {entry.parts!r}")
            flush()
            targets = validate_links(entries, tree)
            for entry in entries.values():
                if isinstance(entry, native.NativeInventorySymlink):
                    output = os.path.join(destination, *entry.parts)
                    os.symlink(entry.target, output)
                    os.lchmod(output, stat.S_IMODE(entry.info.st_mode))
            # Source and output volumes may have different name equivalence. Check
            # literal links only after all exist, while output directories are accessible.
            for parts, equivalents in targets.items():
                actual = native.identity(os.stat(os.path.join(destination, *parts)))
                if not any(actual == native.identity(os.lstat(os.path.join(destination, *target)))
                           for target in equivalents):
                    raise ValueError(f"Worker symlink has no equivalent output target: {parts!r}")
            for entry in reversed(list(entries.values())):
                if isinstance(entry, native.NativeInventoryDirectory):
                    os.chmod(os.path.join(destination, *entry.parts), stat.S_IMODE(entry.info.st_mode))
            tree.validate()
    except BaseException:
        for directory in directories:
            os.chmod(directory, 0o700)
        shutil.rmtree(destination)
        raise
    print(f"Materialized {architecture} worker: retained {retained_files} files; omitted {omitted} native images (first 40 paths logged)", file=sys.stderr)


if __name__ == "__main__":
    try:
        if sys.platform != "darwin" or len(sys.argv) != 5 or sys.argv[4] not in ("arm64", "x86_64"):
            raise ValueError("Usage: materialize-mac-node-worker.py <source> <fresh-output> <staging-parent> <arm64|x86_64> (macOS only)")
        materialize(*sys.argv[1:])
    except Exception as error:
        sys.exit(f"[materialize-mac-node-worker] FAILED: {error}")
