// Exercise publication and provisioning boundaries without signing, service control, or operator state.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { registerMacWorkerMaterializationTests } from "./mac-node-worker-materialization.test-support.js";

registerMacWorkerMaterializationTests();

const temps = useAutoCleanupTempDirTracker(afterEach);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("Mac app worker publication", () => {
  it.each(["sign", "worker", "seal", "stage", "success"])(
    "publishes only a verified replacement (%s)",
    (failure) => {
      const root = temps.make("openclaw-worker-publication-");
      const target = path.join(root, "OpenClaw.app");
      const staged = path.join(root, "candidate.app");
      mkdirSync(target);
      mkdirSync(staged);
      writeFileSync(path.join(target, "worker"), "old signed worker");
      writeFileSync(path.join(staged, "worker"), "new signed worker");
      const packageScript = readFileSync("scripts/package-mac-app.sh", "utf8");
      const publication = packageScript.slice(
        packageScript.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]'),
      );
      const worker = path.join(staged, "Contents/Resources/node-worker/arm64/bin/node");
      mkdirSync(path.dirname(worker), { recursive: true });
      writeFileSync(worker, `#!/bin/bash\nexit ${failure === "worker" ? 6 : 0}\n`);
      chmodSync(worker, 0o755);
      const scripts = path.join(root, "scripts");
      mkdirSync(scripts);
      writeFileSync(
        path.join(scripts, "codesign-mac-app.sh"),
        `#!/bin/bash\nexit ${failure === "sign" ? 9 : 0}\n`,
      );
      chmodSync(path.join(scripts, "codesign-mac-app.sh"), 0o755);
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
      set -euo pipefail
      source scripts/lib/mac-app-bundle.sh
      ROOT_DIR=${quote(root)}
      APP_ROOT=${quote(staged)}
      APP_STAGE_DIR=${quote(root)}
      BUILD_ARCHS=(arm64)
      APP_DESTINATION=${quote(target)}
      codesign_calls=0
      codesign() {
        codesign_calls=$((codesign_calls + 1))
        if [[ ${quote(failure)} == seal && "$codesign_calls" -eq 2 ]]; then return 1; fi
        return 0
      }
      stop_packaged_app_if_running() { :; }
      mv() {
        if [[ "$1" == "$APP_ROOT" && ${quote(failure)} == stage ]]; then return 7; fi
        command mv "$@"
      }
      ${publication}
    `,
        ],
        { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" } },
      );
      expect(result.status, result.stderr).toBe(
        failure === "success" ? 0 : failure === "worker" ? 6 : failure === "sign" ? 9 : 1,
      );
      expect(readFileSync(path.join(target, "worker"), "utf8")).toBe(
        failure === "success" ? "new signed worker" : "old signed worker",
      );
    },
  );

  it("provisions packages without invoking the service owner or changing operator state", () => {
    const root = temps.make("openclaw-worker-provision-");
    const home = path.join(root, "home");
    const prefix = path.join(root, "private");
    const sentinel = path.join(root, "operator", ".openclaw", "state", "sentinel");
    mkdirSync(path.dirname(sentinel), { recursive: true });
    mkdirSync(home);
    writeFileSync(sentinel, "operator-owned");
    const nodeDir = path.join(prefix, "tools", "node-v24.19.0");
    mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
    // Only npm/network is replaced. The real install_openclaw implementation
    // must remain a provision-only seam even when a loaded Gateway is reported.
    symlinkSync(process.execPath, path.join(nodeDir, "bin", "node"));
    const npm = path.join(nodeDir, "bin", "npm");
    writeFileSync(
      npm,
      `#!/bin/bash
case "$1" in
  --version) echo 11.15.0 ;;
  config) echo null ;;
  install)
    mkdir -p "$HOME/../private/tools/node-v24.19.0/lib/node_modules/openclaw/dist"
    touch "$HOME/../private/tools/node-v24.19.0/lib/node_modules/openclaw/dist/entry.js"
    ;;
  *) exit 4 ;;
esac
`,
    );
    chmodSync(npm, 0o755);
    const calls = path.join(root, "service-calls");
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `
      set -euo pipefail
      source scripts/install-cli.sh
      PREFIX=${quote(prefix)}
      OPENCLAW_VERSION=/fixture/openclaw.tgz
      is_gateway_daemon_loaded() { echo loaded >> ${quote(calls)}; return 0; }
      refresh_gateway_service_if_loaded() { echo refresh >> ${quote(calls)}; }
      install_openclaw
      test -f "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"
    `,
      ],
      {
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: `${path.join(nodeDir, "bin")}:/usr/bin:/bin`,
          OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("operator-owned");
  });
});

describe.runIf(process.platform === "darwin")("Mac worker portability inventory", () => {
  it("audits supported thin and fat formats through real otool", async () => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture } = await import("../helpers/mac-native.js");
    const root = temps.make("openclaw-portability-native-");
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    for (const bits of [32, 64]) {
      for (const little of [false, true]) {
        for (const fat of [false, true]) {
          if (fat && little) {
            continue;
          }
          const filename = path.join(root, `${bits}-${little}-${fat} addon`);
          writeFileSync(filename, machoFixture(bits, little, fat, 6));
        }
      }
    }
    symlinkSync("node", path.join(root, "internal-link"));
    expect(auditMacWorkerPortability(root, node)).toBe(7);
  });

  it.each([
    "Java",
    "fat32 archive",
    "fat64 archive",
    "thin object",
    "fat32 object",
    "fat64 object",
  ])("preserves %s resources without treating them as loadable images", async (kind) => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture, nativeObjectFixture, universalArchiveFixture } =
      await import("../helpers/mac-native.js");
    const parent = temps.make("openclaw-portability-resource-");
    const root = path.join(parent, "runtime");
    mkdirSync(root);
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    const filename = path.join(root, "opaque-resource");
    const format = kind.startsWith("fat32") ? "fat32" : kind.startsWith("fat64") ? "fat64" : "thin";
    const inputs = path.join(parent, "resource-inputs");
    const bytes =
      kind === "Java"
        ? Buffer.from("cafebabe0000003d0001", "hex")
        : kind.endsWith("archive")
          ? universalArchiveFixture(inputs, format === "fat64", false)
          : nativeObjectFixture(inputs, format);
    writeFileSync(filename, bytes);
    expect(auditMacWorkerPortability(root, node)).toBe(1);
    expect(readFileSync(filename)).toEqual(bytes);
  });

  it.each([false, true])(
    "binds captured symlink targets before publication (replacement: %s)",
    (replace) => {
      const root = temps.make("openclaw-native-link-binding-");
      const result = spawnSync(
        "/usr/bin/python3",
        [
          "-B",
          "-c",
          `
import os, pathlib, runpy, shutil, sys
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root = pathlib.Path(sys.argv[1])
source, output = root / 'source', root / 'output'
source.mkdir(); output.mkdir()
(source / 'a.txt').write_text('alpha')
(source / 'b.txt').write_text('bravo')
(source / 'alias').symlink_to('a.txt')
before = os.lstat(source / 'alias')
readlink = os.readlink
swapped = False
def replace_link(name, *, dir_fd=None):
    global swapped
    if sys.argv[2] == 'true' and name == 'alias' and dir_fd is not None and not swapped:
        swapped = True
        os.rename('alias', 'held', src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        os.symlink('b.txt', 'alias', dir_fd=dir_fd)
        target = readlink(name, dir_fd=dir_fd)
        os.unlink('alias', dir_fd=dir_fd)
        os.rename('held', 'alias', src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        return target
    return readlink(name, dir_fd=dir_fd)
os.readlink = replace_link
accepted = False
try:
    with api['open_native_inventory_tree'](source) as tree:
        for entry in tree.entries():
            destination = output.joinpath(*entry.parts)
            if isinstance(entry, api['NativeInventoryFile']):
                with destination.open('wb') as target: shutil.copyfileobj(entry.stream, target)
            elif isinstance(entry, api['NativeInventorySymlink']):
                destination.symlink_to(entry.target)
        tree.validate()
        accepted = True
except ValueError as error:
    assert 'changed' in str(error), str(error)
assert readlink(source / 'alias') == 'a.txt'
assert os.lstat(source / 'alias').st_ino == before.st_ino
if sys.argv[2] == 'true':
    assert swapped
    assert not accepted, 'Captured replacement target passed binding validation'
else:
    assert accepted
    assert readlink(output / 'alias') == 'a.txt'
    assert (output / 'alias').read_text() == 'alpha'
print('symlink-binding-ok')
`,
          root,
          String(replace),
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("symlink-binding-ok");
    },
  );

  it("looks up actual filesystem child names without following links or leaking handles", () => {
    const root = temps.make("openclaw-native-child-lookup-");
    const result = spawnSync(
      "/usr/bin/python3",
      [
        "-B",
        "-c",
        `
import os, pathlib, runpy, sys, unicodedata
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root = pathlib.Path(sys.argv[1])
source = root / 'source'
(source / 'Library').mkdir(parents=True)
(source / 'Library/AddOn.node').write_text('resource')
(source / 'Café.txt').write_text('unicode resource')
special = 'slash' + chr(92) + chr(10) + 'name'
(source / special).write_text('literal name')
(root / 'outside').mkdir()
(root / 'outside/probe').write_text('outside')
(source / 'redirect').symlink_to('../outside')
initial_fds = set(os.listdir('/dev/fd'))
with api['open_native_inventory_tree'](source) as tree:
    entries = {entry.parts: entry for entry in tree.entries()}
    queries = [((), 'Library', ('Library',)), ((), 'library', ('Library',)),
               (('Library',), 'addon.node', ('Library', 'AddOn.node')),
               ((), unicodedata.normalize('NFD', 'Café.txt'), ('Café.txt',)),
               ((), special, (special,)), ((), 'redirect', ('redirect',))]
    for parent, name, canonical in queries:
        try: os.stat(source.joinpath(*parent, name), follow_symlinks=False)
        except FileNotFoundError:
            try: tree.lstat_child(parent, name)
            except FileNotFoundError: pass
            else: raise AssertionError('Invented filesystem name equivalence')
        else:
            actual = tree.lstat_child(parent, name)
            assert api['content_identity'](actual) == api['content_identity'](entries[canonical].info)
    for name in ('', '.', '..', '/outside', 'redirect/probe', 'x' + chr(0)):
        try: tree.lstat_child((), name)
        except ValueError: pass
        else: raise AssertionError('Lookup escaped its single-child boundary')
    try: tree.lstat_child(('redirect',), 'probe')
    except ValueError: pass
    else: raise AssertionError('Lookup followed an untraversed symlink parent')
    tree.validate()
try: tree.lstat_child((), 'Library')
except ValueError as error: assert 'closed' in str(error)
else: raise AssertionError('Lookup survived tree closure')
assert set(os.listdir('/dev/fd')) == initial_fds
print('child-lookup-ok')
`,
        root,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("child-lookup-ok");
  });

  it.each([
    "missing",
    "leaf-replacement",
    "parent-link",
    "parent-directory",
    "root",
    "new-hardlink",
  ])("rejects changed child lookup bindings and closes handles (%s)", (mutation) => {
    const root = temps.make("openclaw-native-child-replacement-");
    const result = spawnSync(
      "/usr/bin/python3",
      [
        "-B",
        "-c",
        `
import os, pathlib, runpy, sys
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root = pathlib.Path(sys.argv[1])
source, outside = root / 'source', root / 'outside'
(source / 'Library').mkdir(parents=True)
(source / 'Library/addon').write_text('original')
outside.mkdir(); (outside / 'addon').write_text('outside')
initial_fds = set(os.listdir('/dev/fd'))
with api['open_native_inventory_tree'](source) as tree:
    entries = list(tree.entries())
    parent, name = ('Library',), 'addon'
    mode = sys.argv[2]
    if mode == 'missing': (source / 'Library/addon').unlink()
    elif mode == 'leaf-replacement':
        (source / 'Library/addon').unlink()
        (source / 'Library/addon').symlink_to('../../outside/addon')
    elif mode in ('parent-link', 'parent-directory'):
        (source / 'Library').rename(root / 'held')
        if mode == 'parent-link': (source / 'Library').symlink_to(outside)
        else:
            (source / 'Library').mkdir()
            (source / 'Library/addon').write_text('replacement')
    elif mode == 'root':
        source.rename(root / 'held')
        source.mkdir()
    else:
        os.link(source / 'Library/addon', source / 'new-alias')
        parent, name = (), 'new-alias'
    try: tree.lstat_child(parent, name)
    except (OSError, ValueError): pass
    else: raise AssertionError('Changed namespace lookup was accepted')
    if mode == 'root':
        try: tree.validate()
        except (OSError, ValueError): pass
        else: raise AssertionError('Final validation skipped root replacement')
assert (outside / 'addon').read_text() == 'outside'
assert set(os.listdir('/dev/fd')) == initial_fds
print('child-binding-rejected')
`,
        root,
        mutation,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("child-binding-rejected");
  });

  it.each(["namespace-root", "namespace-nested", "discarded-resource", "incomplete"])(
    "rejects incomplete or changed observed input even when not retained (%s)",
    async (mode) => {
      const { machoFixture } = await import("../helpers/mac-native.js");
      const root = temps.make("openclaw-native-complete-audit-");
      const directory = path.join(
        root,
        "source",
        ...(mode === "namespace-nested" ? ["child"] : []),
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "resource"),
        mode === "discarded-resource" ? machoFixture() : "resource",
      );
      const result = spawnSync(
        "/usr/bin/python3",
        [
          "-B",
          "-c",
          `
import os, pathlib, runpy, sys
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
source = root / 'source'
directory = source / 'child' if mode == 'namespace-nested' else source
resource = directory / 'resource'
original, original_info = resource.read_bytes(), resource.stat()
initial_fds = set(os.listdir('/dev/fd'))
held = None
try:
    with api['open_native_inventory_tree'](source) as tree:
        iterator = tree.entries()
        records = [next(iterator)]
        if mode.startswith('namespace-'):
            if mode == 'namespace-nested': records.append(next(iterator))
            before = directory.stat()
            resource.rename(root / 'hidden')
            records.extend(iterator)
            assert not any(entry.parts and entry.parts[-1] == 'resource' for entry in records)
            (root / 'hidden').rename(resource)
            assert api['content_identity'](directory.stat()) != api['content_identity'](before)
        elif mode == 'discarded-resource':
            for entry in iterator:
                records.append(entry)
                if isinstance(entry, api['NativeInventoryFile']):
                    held = os.fdopen(os.dup(entry.stream.fileno()), 'rb', buffering=0)
            resource.write_bytes(bytes.fromhex('cafebabe0000003d0001'))
            assert api['classify_macho_candidates']([(held, 'resource')]) == [None]
            resource.write_bytes(original)
            os.utime(resource, ns=(original_info.st_atime_ns, original_info.st_mtime_ns))
            assert resource.stat().st_ino == original_info.st_ino
            assert resource.stat().st_ctime_ns != original_info.st_ctime_ns
        try: tree.validate()
        except ValueError as error:
            assert ('complete' if mode == 'incomplete' else 'changed') in str(error), str(error)
        else: raise AssertionError('Incomplete or changed observed input was accepted')
finally:
    if held is not None: held.close()
assert resource.read_bytes() == original
assert set(os.listdir('/dev/fd')) == initial_fds
print('complete-audit-rejected')
`,
          root,
          mode,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("complete-audit-rejected");
    },
  );

  it.each(["stable", "ancestor-symlink", "ancestor-directory", "root-swap"])(
    "audits deep trees with linear opens and bounded handles (%s)",
    (mode) => {
      const root = temps.make("openclaw-native-audit-depth-");
      const result = spawnSync(
        "/usr/bin/python3",
        [
          "-B",
          "-c",
          `
import os, pathlib, runpy, sys
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
source, outside = root / 'source', root / 'outside'
source.mkdir(); outside.mkdir()
(outside / 'a-resource').write_text('outside')
folder = source
for _ in range(12):
    folder = folder / 'branch'
    folder.mkdir()
    (folder / 'a-resource').write_text('resource')
    (folder / 'z-empty').mkdir()
initial_fds = set(os.listdir('/dev/fd'))
original_open, original_stat = os.open, os.stat
opens, peak, swapped = 0, len(initial_fds), False
def opened(name, flags, *args, **kwargs):
    global opens, peak
    fd = original_open(name, flags, *args, **kwargs)
    opens += bool(flags & os.O_DIRECTORY)
    peak = max(peak, len(os.listdir('/dev/fd')))
    assert api['identity'](os.fstat(fd)) != api['identity'](original_stat(outside)), 'Opened external directory'
    return fd
def stated(name, *args, **kwargs):
    global swapped
    info = original_stat(name, *args, **kwargs)
    if mode != 'stable' and name == 'a-resource' and not swapped:
        swapped = True
        replaced = source if mode == 'root-swap' else source / 'branch'
        replaced.rename(root / 'held')
        if mode == 'ancestor-directory': replaced.mkdir()
        else: replaced.symlink_to(outside)
    return info
with api['open_native_inventory_tree'](source) as tree:
    entries = list(tree.entries())
    directories = sum(isinstance(entry, api['NativeInventoryDirectory']) for entry in entries)
    depth = max(len(entry.parts) for entry in entries)
    os.open, os.stat = opened, stated
    try:
        try: tree.validate()
        except (OSError, ValueError): assert mode != 'stable'
        else:
            assert mode == 'stable', 'Audit accepted a replaced ancestor'
            assert opens <= directories * 3, (opens, directories)
        assert peak <= len(initial_fds) + depth + 3, (peak, depth)
    finally:
        os.open, os.stat = original_open, original_stat
assert swapped == (mode != 'stable')
assert (outside / 'a-resource').read_text() == 'outside'
assert set(os.listdir('/dev/fd')) == initial_fds
print('bounded-audit-ok')
`,
          root,
          mode,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("bounded-audit-ok");
    },
  );

  it.each(["finish", "abort"])(
    "binds classify-and-copy to borrowed files and closes them on %s",
    async (mode) => {
      const { machoFixture } = await import("../helpers/mac-native.js");
      const root = temps.make("openclaw-native-borrow-");
      const source = path.join(root, "source");
      const outside = path.join(root, "outside");
      mkdirSync(path.join(source, "dir"), { recursive: true });
      mkdirSync(path.join(source, "empty"));
      mkdirSync(outside);
      writeFileSync(path.join(source, "dir", "native"), machoFixture());
      writeFileSync(path.join(outside, "native"), machoFixture(64, true, false, 6));
      writeFileSync(path.join(source, "resource.txt"), "ordinary resource");
      writeFileSync(
        path.join(source, "resource.class"),
        Buffer.from("cafebabe0000003d0001", "hex"),
      );
      writeFileSync(path.join(source, "invalid"), machoFixture(32, true, true));
      symlinkSync("../outside", path.join(source, "link"));
      expect(spawnSync("/usr/bin/mkfifo", [path.join(source, "fifo")]).status).toBe(0);
      const result = spawnSync(
        "/usr/bin/python3",
        [
          "-c",
          `
import os, pathlib, runpy, shutil, sys
api = runpy.run_path('scripts/lib/mac-native-inventory.py')
root = pathlib.Path(sys.argv[1])
source = root / 'source'
original = (source / 'dir/native').read_bytes()
resources = {('resource.txt',): b'ordinary resource', ('resource.class',): bytes.fromhex('cafebabe0000003d0001')}
initial_fds = set(os.listdir('/dev/fd'))
class CopyAborted(Exception): pass
borrowed = None
seen = []
try:
    with api['open_native_inventory_tree'](source) as tree:
        iterator = tree.entries()
        for entry in iterator:
            seen.append((type(entry).__name__, entry.parts))
            if isinstance(entry, api['NativeInventorySymlink']):
                assert entry.target == '../outside'
            if not isinstance(entry, api['NativeInventoryFile']): continue
            assert entry.stream.tell() == 0
            if entry.parts == ('dir', 'native'):
                borrowed = entry.stream
                os.rename(source / 'dir', root / 'retained')
                os.symlink(root / 'outside', source / 'dir')
                assert api['classify_macho_candidates']([(borrowed, 'native')]) == [b'executable']
                assert borrowed.tell() == 0
                with (root / 'copied-native').open('wb') as output:
                    shutil.copyfileobj(borrowed, output)
                assert (root / 'copied-native').read_bytes() == original
                if sys.argv[2] == 'abort': raise CopyAborted()
            else:
                assert borrowed.closed
                if entry.parts == ('invalid',):
                    entry.stream.seek(7)
                    try: api['classify_macho_candidates']([(entry.stream, 'invalid')])
                    except ValueError: pass
                    else: raise AssertionError('Invalid native container was accepted')
                    assert entry.stream.tell() == 7
                    continue
                if entry.header in api['MACHO_MAGICS']:
                    assert api['classify_macho_candidates']([(entry.stream, 'resource')]) == [None]
                assert entry.stream.tell() == 0
                assert entry.stream.read() == resources[entry.parts]
        assert ('NativeInventoryDirectory', ('empty',)) in seen
        assert ('NativeInventorySpecial', ('fifo',)) in seen
        assert ('NativeInventorySymlink', ('link',)) in seen
        try: tree.validate()
        except NotADirectoryError as error: assert error.filename == 'dir'
        except ValueError as error: assert 'changed' in str(error)
        else: raise AssertionError('Replaced pathname was accepted')
except CopyAborted:
    assert sys.argv[2] == 'abort'
assert borrowed.closed
try: borrowed.fileno()
except ValueError: pass
else: raise AssertionError('Borrowed descriptor survived its context')
assert next(iterator, None) is None
try: tree.validate()
except ValueError: pass
else: raise AssertionError('Closed tree remained usable')
assert set(os.listdir('/dev/fd')) == initial_fds
print('held-file-copy-ok')
`,
          root,
          mode,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("held-file-copy-ok");
    },
  );

  it.each(["file", "directory", "dangling"])(
    "rejects %s symlinks outside the worker",
    async (kind) => {
      const { auditMacWorkerPortability } =
        await import("../../scripts/lib/mac-worker-portability.mjs");
      const { machoFixture } = await import("../helpers/mac-native.js");
      const parent = temps.make("openclaw-portability-link-");
      const root = path.join(parent, "runtime");
      mkdirSync(root);
      const node = path.join(root, "node");
      writeFileSync(node, machoFixture());
      const external = path.join(parent, "external");
      if (kind === "directory") {
        mkdirSync(external);
      }
      if (kind === "file") {
        writeFileSync(external, "outside");
      }
      symlinkSync(external, path.join(root, "link"));
      expect(() => auditMacWorkerPortability(root, node)).toThrow(
        kind === "dangling" ? /ENOENT/ : /symlink escapes/,
      );
    },
  );

  it("does not borrow loader paths from a different architecture", async () => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture } = await import("../helpers/mac-native.js");
    const root = temps.make("openclaw-portability-slices-");
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    const command = (id: number, value: string, offset: number) => {
      const name = Buffer.from(value + "\0");
      const bytes = Buffer.alloc(Math.ceil((offset + name.length) / 8) * 8);
      bytes.writeUInt32LE(id, 0);
      bytes.writeUInt32LE(bytes.length, 4);
      bytes.writeUInt32LE(offset, 8);
      name.copy(bytes, offset);
      return bytes;
    };
    const slice = (cpu: number, subtype: number, folder: string) => {
      const header = machoFixture(64, true, false, 6);
      const commands = Buffer.concat([
        command(0x8000001c, `@loader_path/${folder}`, 12),
        command(0xc, "@rpath/libdemo.dylib", 24),
      ]);
      header.writeUInt32LE(cpu, 4);
      header.writeUInt32LE(subtype, 8);
      header.writeUInt32LE(2, 16);
      header.writeUInt32LE(commands.length, 20);
      return Buffer.concat([header, commands]);
    };
    const slices = [slice(0x01000007, 3, "empty"), slice(0x0100000c, 0x80000002, "valid")] as const;
    const payload = Buffer.alloc(8192 + slices[1].length);
    payload.writeUInt32BE(0xcafebabf, 0);
    payload.writeUInt32BE(2, 4);
    for (const [index, bytes] of slices.entries()) {
      const record = 8 + index * 32;
      const offset = 4096 * (index + 1);
      payload.writeUInt32BE(bytes.readUInt32LE(4), record);
      payload.writeUInt32BE(bytes.readUInt32LE(8), record + 4);
      payload.writeBigUInt64BE(BigInt(offset), record + 8);
      payload.writeBigUInt64BE(BigInt(bytes.length), record + 16);
      payload.writeUInt32BE(12, record + 24);
      bytes.copy(payload, offset);
    }
    const addon = path.join(root, "addon");
    writeFileSync(addon, payload);
    mkdirSync(path.join(root, "empty"));
    mkdirSync(path.join(root, "valid"));
    writeFileSync(path.join(root, "valid/libdemo.dylib"), machoFixture(64, true, false, 6));
    expect(spawnSync("/usr/bin/lipo", ["-archs", addon]).status).toBe(0);
    expect(() => auditMacWorkerPortability(root, node)).toThrow(/Nonportable LC_LOAD_DYLIB/);
  });

  it.each(
    [
      "/usr/lib/libSystem.B.dylib",
      "/opt/homebrew/lib/nonportable.dylib",
      "/usr/lib/../../opt/homebrew/lib/nonportable.dylib",
      "/System/Library/../../opt/homebrew/lib/nonportable.dylib",
      "@loader_path/../../outside.dylib",
    ].flatMap((library) => ["thin", "fat64"].map((format) => ({ library, format }))),
  )("audits load dependencies after inventory ($format, $library)", async ({ library, format }) => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture } = await import("../helpers/mac-native.js");
    const root = temps.make("openclaw-portability-load-");
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    const addon = path.join(root, "addon");
    const header = machoFixture(64, true, false, 6);
    const name = Buffer.from(library + "\0");
    const command = Buffer.alloc(Math.ceil((24 + name.length) / 8) * 8);
    command.writeUInt32LE(0xc, 0); // LC_LOAD_DYLIB
    command.writeUInt32LE(command.length, 4);
    command.writeUInt32LE(24, 8);
    name.copy(command, 24);
    header.writeUInt32LE(1, 16);
    header.writeUInt32LE(command.length, 20);
    const thin = Buffer.concat([header, command]);
    // On-disk fat headers are big endian; the arm64 slice is little endian.
    const payload =
      format === "fat64"
        ? Buffer.concat([machoFixture(64, false, true, 6).subarray(0, 4096), thin])
        : thin;
    if (format === "fat64") {
      payload.writeBigUInt64BE(BigInt(thin.length), 24);
    }
    writeFileSync(addon, payload);
    const load = spawnSync("/usr/bin/otool", ["-l", addon], { encoding: "utf8" });
    expect(load.status, load.stderr).toBe(0);
    expect(load.stdout).toContain(`name ${library} (offset 24)`);
    if (library === "/usr/lib/libSystem.B.dylib") {
      expect(auditMacWorkerPortability(root, node)).toBe(2);
    } else {
      expect(() => auditMacWorkerPortability(root, node)).toThrow(/Nonportable LC_LOAD_DYLIB/);
    }
  });
});
