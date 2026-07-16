import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/release-telegram-candidate-archive.py");
const tempDirs: string[] = [];
const tarVersion = spawnSync("tar", ["--version"], { encoding: "utf8" });
const hasGnuTar = tarVersion.status === 0 && tarVersion.stdout?.includes("GNU tar") === true;

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-archive-guard-"));
  tempDirs.push(directory);
  return directory;
}

function runHelper(args: string[]) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function expectSuccess(args: string[]) {
  const result = runHelper(args);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function expectFailure(args: string[], message: string) {
  const result = runHelper(args);
  expect(result.status, result.stdout).toBe(1);
  expect(result.stderr).toContain(message);
  return result;
}

function compressTar(tarPath: string): string {
  const archivePath = `${tarPath}.zst`;
  const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
    encoding: "utf8",
  });
  expect(zstdResult.status, zstdResult.stderr).toBe(0);
  return archivePath;
}

function makeCompressedArchive(root: string, fileSize = 32): string {
  const source = path.join(root, "source");
  const candidate = path.join(source, "candidate");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(path.join(source, "manifest.json"), '{"version":1}\n');
  writeFileSync(path.join(candidate, "payload.bin"), Buffer.alloc(fileSize, 0x61));

  const tarPath = path.join(root, "candidate.tar");
  const tarResult = spawnSync("tar", ["-cf", tarPath, "-C", source, "manifest.json", "candidate"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(tarResult.status, tarResult.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeDepthFirstProducerArchive(root: string): string {
  const source = path.join(root, "depth-first-source");
  const candidate = path.join(source, "candidate");
  mkdirSync(path.join(candidate, "app"), { recursive: true });
  writeFileSync(path.join(source, "manifest.json"), '{"version":1}\n');
  writeFileSync(path.join(candidate, "app", "child"), "child\n");
  writeFileSync(path.join(candidate, "app-routes.ts"), "routes\n");

  const archivePath = path.join(root, "depth-first-producer.tar.zst");
  const script = String.raw`
set -euo pipefail
cd "$SOURCE"
LC_ALL=C tar \
  --create \
  --format=posix \
  --sort=name \
  --one-file-system \
  --numeric-owner \
  --owner=0 \
  --group=0 \
  --no-xattrs \
  --no-acls \
  --pax-option=delete=atime,delete=ctime \
  manifest.json \
  candidate |
zstd -T0 -3 -q -o "$ARCHIVE"
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARCHIVE: archivePath,
      SOURCE: source,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return archivePath;
}

function makeDeclaredExtensionArchive(
  root: string,
  kind: "gnu-longlink" | "gnu-longname" | "pax" | "pax-global",
  size: number,
): string {
  const tarPath = path.join(root, `${kind}.tar`);
  const python = String.raw`
import sys
import tarfile

types = {
    "gnu-longlink": tarfile.GNUTYPE_LONGLINK,
    "gnu-longname": tarfile.GNUTYPE_LONGNAME,
    "pax": tarfile.XHDTYPE,
    "pax-global": tarfile.XGLTYPE,
}
header = tarfile.TarInfo("././@PaxHeader")
header.type = types[sys.argv[2]]
header.size = int(sys.argv[3])
with open(sys.argv[1], "wb") as output:
    output.write(header.tobuf(format=tarfile.USTAR_FORMAT))
`;
  const result = spawnSync("python3", ["-c", python, tarPath, kind, String(size)], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeLongMetadataArchive(
  root: string,
  kind: "gnu-longname" | "hardlink" | "pax-path" | "symlink",
): string {
  const tarPath = path.join(root, `${kind}-metadata.tar`);
  const python = String.raw`
import io
import sys
import tarfile

kind = sys.argv[2]
archive_format = tarfile.GNU_FORMAT if kind == "gnu-longname" else tarfile.PAX_FORMAT
with tarfile.open(sys.argv[1], "w", format=archive_format) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    long_value = "a" * 4097
    if kind in {"gnu-longname", "pax-path"}:
        member = tarfile.TarInfo(f"candidate/{long_value}")
        member.size = 1
        archive.addfile(member, io.BytesIO(b"x"))
    else:
        member = tarfile.TarInfo(f"candidate/{kind}")
        member.type = tarfile.LNKTYPE if kind == "hardlink" else tarfile.SYMTYPE
        member.linkname = long_value
        archive.addfile(member)
`;
  const result = spawnSync("python3", ["-c", python, tarPath, kind], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeDeepSortedArchive(root: string, pathCount: number): string {
  const tarPath = path.join(root, "deep-sorted.tar");
  const python = String.raw`
import io
import sys
import tarfile

path_count = int(sys.argv[2])
with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    # One shared prefix preserves the 256-component boundary and distinct leaves
    # without rebuilding the same deep parent chain for every sibling.
    parts = ["candidate", *["d" for _ in range(254)]]
    for component_count in range(2, len(parts) + 1):
        directory = tarfile.TarInfo("/".join(parts[:component_count]))
        directory.type = tarfile.DIRTYPE
        archive.addfile(directory)

    for index in range(path_count):
        member = tarfile.TarInfo("/".join([*parts, f"{index:04d}"]))
        member.size = 1
        archive.addfile(member, io.BytesIO(b"x"))
`;
  const result = spawnSync("python3", ["-c", python, tarPath, String(pathCount)], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeCumulativePaxArchive(root: string): string {
  const tarPath = path.join(root, "cumulative-pax.tar");
  const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    for index in range(5):
        member = tarfile.TarInfo(f"candidate/pax-{index}")
        member.pax_headers = {"comment": "x" * 400}
        archive.addfile(member)
`;
  const result = spawnSync("python3", ["-c", python, tarPath], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeValidHardlinkArchive(root: string): string {
  const tarPath = path.join(root, "valid-hardlink.tar");
  const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.USTAR_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    target = tarfile.TarInfo("candidate/a-target.txt")
    target_payload = b"shared\n"
    target.size = len(target_payload)
    archive.addfile(target, io.BytesIO(target_payload))

    link = tarfile.TarInfo("candidate/b-link.txt")
    link.type = tarfile.LNKTYPE
    link.linkname = target.name
    archive.addfile(link)
`;
  const result = spawnSync("python3", ["-c", python, tarPath], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeManyMemberTar(root: string, memberCount: number): string {
  const tarPath = path.join(root, "many-members.tar");
  const python = String.raw`
import sys
import tarfile

member_count = int(sys.argv[2])
if member_count < 2:
    raise ValueError("member count must include manifest and candidate root")

with open(sys.argv[1], "wb") as output:
    manifest = tarfile.TarInfo("manifest.json")
    output.write(manifest.tobuf(format=tarfile.USTAR_FORMAT))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    output.write(root.tobuf(format=tarfile.USTAR_FORMAT))

    # Only the short ASCII name changes across these empty regular members.
    # Reuse one stdlib-generated USTAR header and adjust its name/checksum so
    # the 100k-member stress case spends its time in the reader under test.
    member_header = bytearray(
        tarfile.TarInfo("candidate/f000000").tobuf(format=tarfile.USTAR_FORMAT)
    )
    member_header[:100] = b"\0" * 100
    member_header[148:156] = b" " * 8
    member_base_checksum = sum(member_header)

    for index in range(member_count - 2):
        name = f"candidate/f{index:06d}".encode("ascii")
        header = member_header.copy()
        header[:len(name)] = name
        checksum = member_base_checksum + sum(name)
        header[148:156] = f"{checksum:06o}\0 ".encode("ascii")
        output.write(header)

    output.write(b"\0" * 1024)
`;
  const result = spawnSync("python3", ["-c", python, tarPath, String(memberCount)], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return tarPath;
}

function makePaxHeavyTar(root: string, memberCount: number, keyCount: number): string {
  const tarPath = path.join(root, "pax-heavy.tar");
  const python = String.raw`
import sys
import tarfile

member_count = int(sys.argv[2])
key_count = int(sys.argv[3])
with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    archive.addfile(manifest)

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    for index in range(member_count):
        member = tarfile.TarInfo(f"candidate/p{index:06d}")
        member.pax_headers = {
            f"OPENCLAW.key{key:03d}": f"{index:06d}-{key:03d}"
            for key in range(key_count)
        }
        archive.addfile(member)
`;
  const result = spawnSync(
    "python3",
    ["-c", python, tarPath, String(memberCount), String(keyCount)],
    {
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function probeTarInfoCache(tarPath: string) {
  const launcher = String.raw`
import subprocess
import sys

completed = subprocess.run([sys.executable, "-c", sys.argv[1], *sys.argv[2:]])
raise SystemExit(completed.returncode)
`;
  const python = String.raw`
import importlib.util
import json
import resource
import sys
import tarfile

spec = importlib.util.spec_from_file_location("archive_guard", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

count = 0
max_cached_members = 0
with tarfile.open(sys.argv[2], mode="r|", bufsize=512) as archive:
    while True:
        member, cached_members = module._next_stream_member(archive)
        max_cached_members = max(max_cached_members, cached_members)
        if archive.members:
            raise RuntimeError("tar metadata cache was not cleared")
        if member is None:
            break
        count += 1

resident_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
if sys.platform == "darwin":
    resident_kib //= 1024
print(json.dumps({
    "count": count,
    "maxCachedMembers": max_cached_members,
    "residentKiB": resident_kib,
}))
`;
  return spawnSync("python3", ["-c", launcher, python, SCRIPT, tarPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

describe("release Telegram candidate archive guard", () => {
  it("is executable and accepts an internal symlink", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const root = makeTempDir();
    mkdirSync(path.join(root, "target"));
    writeFileSync(path.join(root, "target", "value.txt"), "ok\n");
    symlinkSync("target/value.txt", path.join(root, "internal-link"));

    const result = expectSuccess([
      "validate-tree",
      root,
      "--max-entries",
      "10",
      "--max-apparent-bytes",
      "1024",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ entries: 3 });
  });

  it("rejects an escaping symlink", () => {
    const container = makeTempDir();
    const root = path.join(container, "root");
    mkdirSync(root);
    writeFileSync(path.join(container, "outside.txt"), "outside\n");
    symlinkSync("../outside.txt", path.join(root, "escape"));

    expectFailure(["validate-tree", root], "escaping symlink");
  });

  it("rejects a symlink supplied as the tree root", () => {
    const container = makeTempDir();
    const target = path.join(container, "target");
    const root = path.join(container, "root-link");
    mkdirSync(target);
    writeFileSync(path.join(target, "value.txt"), "outside\n");
    symlinkSync("target", root);

    expectFailure(["validate-tree", root], "tree root must not be a symlink");
  });

  it("rejects a dangling symlink", () => {
    const root = makeTempDir();
    symlinkSync("missing.txt", path.join(root, "dangling"));

    expectFailure(["validate-tree", root], "dangling symlink");
  });

  it("rejects a socket entry", async () => {
    const root = makeTempDir();
    const socketPath = path.join(root, "candidate.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      expectFailure(["validate-tree", root], "unsupported special entry");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses apparent size when rejecting a sparse file", () => {
    const root = makeTempDir();
    const sparsePath = path.join(root, "sparse.bin");
    writeFileSync(sparsePath, "");
    truncateSync(sparsePath, 2 * 1024 * 1024);

    expectFailure(
      ["validate-tree", root, "--max-apparent-bytes", `${1024 * 1024}`],
      "apparent size exceeds",
    );
  });

  it("rejects a tree over the entry-count cap", () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "one.txt"), "one\n");
    writeFileSync(path.join(root, "two.txt"), "two\n");

    expectFailure(["validate-tree", root, "--max-entries", "1"], "entry count exceeds 1");
  });

  it("rejects a same-device hard link whose other name is outside the tree", () => {
    const container = makeTempDir();
    const root = path.join(container, "root");
    const outside = path.join(container, "outside.txt");
    mkdirSync(root);
    writeFileSync(outside, "outside\n");
    linkSync(outside, path.join(root, "linked.txt"));

    expectFailure(["validate-tree", root], "hard links outside the validated root");
  });

  it("accepts hard links whose complete link set is inside the tree", () => {
    const root = makeTempDir();
    const first = path.join(root, "first.txt");
    writeFileSync(first, "shared\n");
    linkSync(first, path.join(root, "second.txt"));

    const result = expectSuccess(["validate-tree", root]);
    expect(JSON.parse(result.stdout)).toMatchObject({ entries: 2 });
  });

  it("streams and extracts a valid compressed archive", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "extracted");

    const result = expectSuccess([
      "extract-zstd",
      archive,
      destination,
      "--allowed-root",
      "candidate",
      "--max-members",
      "10",
      "--max-expanded-bytes",
      "4096",
      "--max-stream-bytes",
      `${1024 * 1024}`,
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      allowedRoot: "candidate",
      members: 3,
    });
    expect(JSON.parse(result.stdout).maxCachedMembers).toBeLessThanOrEqual(1);
    expect(existsSync(path.join(destination, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(destination, "candidate", "payload.bin"))).toBe(true);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
  });

  it.runIf(hasGnuTar)(
    "accepts the producer's depth-first order around punctuation siblings",
    () => {
      const root = makeTempDir();
      const archive = makeDepthFirstProducerArchive(root);
      const listing = spawnSync("bash", ["-c", 'zstd -dc "$1" | tar -tf -', "bash", archive], {
        encoding: "utf8",
      });
      expect(listing.status, listing.stderr).toBe(0);
      expect(listing.stdout.trim().split("\n")).toEqual([
        "manifest.json",
        "candidate/",
        "candidate/app/",
        "candidate/app/child",
        "candidate/app-routes.ts",
      ]);

      const destination = path.join(root, "depth-first-producer-output");
      const result = expectSuccess([
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ members: 5 });
      expect(readFileSync(path.join(destination, "candidate", "app-routes.ts"), "utf8")).toBe(
        "routes\n",
      );
      expect(readFileSync(path.join(destination, "candidate", "app", "child"), "utf8")).toBe(
        "child\n",
      );
    },
  );

  it("rejects a member whose parent directory was not declared first", () => {
    const root = makeTempDir();
    const tarPath = path.join(root, "missing-parent.tar");
    const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.USTAR_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    child = tarfile.TarInfo("candidate/missing/child.txt")
    child.size = 2
    archive.addfile(child, io.BytesIO(b"ok"))
`;
    const result = spawnSync("python3", ["-c", python, tarPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const archive = compressTar(tarPath);
    const destination = path.join(root, "missing-parent-output");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "archive member parent is not a prior directory",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects compressed archives over the expanded-size cap and cleans up", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root, 4096);
    const destination = path.join(root, "expanded-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-expanded-bytes",
        "1024",
        "--max-stream-bytes",
        `${1024 * 1024}`,
      ],
      "expanded size exceeds",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("extracts a prior-target hard link without retaining TarInfo records", () => {
    const root = makeTempDir();
    const archive = makeValidHardlinkArchive(root);
    const destination = path.join(root, "hardlink-success");

    const result = expectSuccess([
      "extract-zstd",
      archive,
      destination,
      "--allowed-root",
      "candidate",
    ]);
    expect(JSON.parse(result.stdout).maxCachedMembers).toBeLessThanOrEqual(1);
    const target = path.join(destination, "candidate", "a-target.txt");
    const link = path.join(destination, "candidate", "b-link.txt");
    expect(readFileSync(link, "utf8")).toBe("shared\n");
    expect(statSync(link).ino).toBe(statSync(target).ino);
  });

  it("rejects compressed archives over the member-count cap and cleans up", () => {
    const root = makeTempDir();
    const archive = compressTar(makeManyMemberTar(root, 3));
    const destination = path.join(root, "member-limit");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate", "--max-members", "2"],
      "member count exceeds 2",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it.each(["pax", "gnu-longname", "gnu-longlink"] as const)(
    "rejects a declared %s extension before reading its payload",
    (kind) => {
      const root = makeTempDir();
      const archive = makeDeclaredExtensionArchive(root, kind, 4096);
      const destination = path.join(root, `${kind}-limit`);

      expectFailure(
        [
          "extract-zstd",
          archive,
          destination,
          "--allowed-root",
          "candidate",
          "--max-extension-bytes",
          "1024",
        ],
        "extension payload exceeds 1024 bytes",
      );
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("rejects a global PAX header before reading its payload", () => {
    const root = makeTempDir();
    const archive = makeDeclaredExtensionArchive(root, "pax-global", 4096);
    const destination = path.join(root, "pax-global-limit");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "unsupported global PAX header",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects archives over the cumulative extension payload cap", () => {
    const root = makeTempDir();
    const archive = makeCumulativePaxArchive(root);
    const destination = path.join(root, "extension-total-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-extension-bytes",
        "1024",
        "--max-extension-total-bytes",
        "2048",
      ],
      "extension payload total exceeds 2048 bytes",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it.each(["pax-path", "gnu-longname", "symlink", "hardlink"] as const)(
    "rejects an overlong %s path value",
    (kind) => {
      const root = makeTempDir();
      const archive = makeLongMetadataArchive(root, kind);
      const destination = path.join(root, `${kind}-path-limit`);

      expectFailure(
        ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
        "exceeds 4096 bytes",
      );
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("rejects archives over the aggregate path metadata cap", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "path-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-path-bytes",
        "10",
      ],
      "path metadata exceeds 10 bytes",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a hard link from the candidate tree to the manifest", () => {
    const root = makeTempDir();
    const source = path.join(root, "source-hardlink");
    const candidate = path.join(source, "candidate");
    mkdirSync(candidate, { recursive: true });
    const manifest = path.join(source, "manifest.json");
    writeFileSync(manifest, '{"version":1}\n');
    linkSync(manifest, path.join(candidate, "manifest-copy.json"));

    const tarPath = path.join(root, "hardlink.tar");
    const archivePath = `${tarPath}.zst`;
    const tarResult = spawnSync(
      "tar",
      ["-cf", tarPath, "-C", source, "manifest.json", "candidate"],
      {
        encoding: "utf8",
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      },
    );
    expect(tarResult.status, tarResult.stderr).toBe(0);
    const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);

    expectFailure(
      [
        "extract-zstd",
        archivePath,
        path.join(root, "hardlink-output"),
        "--allowed-root",
        "candidate",
      ],
      "hard link target leaves candidate root",
    );
  });

  it("rejects a link that replaces a previously extracted descendant directory", () => {
    const root = makeTempDir();
    const tarPath = path.join(root, "link-prefix.tar");
    const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.USTAR_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    prefix = tarfile.TarInfo("candidate/prefix")
    prefix.type = tarfile.DIRTYPE
    archive.addfile(prefix)

    payload = tarfile.TarInfo("candidate/prefix/file.txt")
    payload.size = 2
    archive.addfile(payload, io.BytesIO(b"ok"))

    replacement = tarfile.TarInfo("candidate/prefix")
    replacement.type = tarfile.SYMTYPE
    replacement.linkname = "file.txt"
    archive.addfile(replacement)
`;
    const result = spawnSync("python3", ["-c", python, tarPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const archive = compressTar(tarPath);

    expectFailure(
      [
        "extract-zstd",
        archive,
        path.join(root, "link-prefix-output"),
        "--allowed-root",
        "candidate",
      ],
      "archive has duplicate path",
    );
  });

  it("rejects duplicate canonical member paths", () => {
    const root = makeTempDir();
    const tarPath = path.join(root, "duplicate.tar");
    const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.USTAR_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    for _ in range(2):
        duplicate = tarfile.TarInfo("candidate/duplicate")
        archive.addfile(duplicate)
`;
    const result = spawnSync("python3", ["-c", python, tarPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const archive = compressTar(tarPath);

    expectFailure(
      ["extract-zstd", archive, path.join(root, "duplicate-output"), "--allowed-root", "candidate"],
      "archive has duplicate path",
    );
  });

  it("rejects a member nested under a prior link", () => {
    const root = makeTempDir();
    const tarPath = path.join(root, "link-parent.tar");
    const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.USTAR_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    link = tarfile.TarInfo("candidate/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "target"
    archive.addfile(link)

    child = tarfile.TarInfo("candidate/link/child.txt")
    child.size = 2
    archive.addfile(child, io.BytesIO(b"ok"))
`;
    const result = spawnSync("python3", ["-c", python, tarPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const archive = compressTar(tarPath);

    expectFailure(
      [
        "extract-zstd",
        archive,
        path.join(root, "link-parent-output"),
        "--allowed-root",
        "candidate",
      ],
      "path traverses a non-directory member",
    );
  });

  it("accepts unique 256-component paths within the metadata budget", () => {
    const root = makeTempDir();
    const archive = makeDeepSortedArchive(root, 32);
    const destination = path.join(root, "deep-sorted-output");

    const result = expectSuccess([
      "extract-zstd",
      archive,
      destination,
      "--allowed-root",
      "candidate",
      "--max-members",
      "10000",
      "--max-path-bytes",
      `${8 * 1024 * 1024}`,
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ members: 288 });
    expect(JSON.parse(result.stdout).maxCachedMembers).toBeLessThanOrEqual(1);
  });

  it("bounds exact names and clears the stdlib TarInfo cache", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain("seen_names");
    expect(source).toContain("_validate_destination_paths");
    expect(source).toContain(".lstat()");
    expect(source).toContain("parent_name not in seen_names");
    expect(source).toContain("_next_stream_member");
    expect(source).toContain("archive.members.clear()");
    expect(source).not.toContain("target_path.parent.mkdir");
    expect(source).not.toContain("for member in archive");
    expect(source).not.toContain("previous_sort_key");
    expect(source).not.toContain("link_names");
    expect(source).not.toContain("seen_parent_names");
    expect(source).not.toContain("any(existing.startswith");
  });

  it("keeps TarInfo cache and resident memory bounded across 100000 members", () => {
    const root = makeTempDir();
    const tarPath = makeManyMemberTar(root, 100_000);
    const result = probeTarInfoCache(tarPath);
    expect(result.status, result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout);
    expect(probe).toMatchObject({
      count: 100_000,
    });
    expect(probe.maxCachedMembers).toBeLessThanOrEqual(1);
    expect(probe.residentKiB).toBeLessThan(128 * 1024);
  }, 30_000);

  it("clears PAX metadata from the TarInfo cache after every member", () => {
    const root = makeTempDir();
    const archive = makePaxHeavyTar(root, 1_200, 128);
    const result = expectSuccess([
      "extract-zstd",
      archive,
      path.join(root, "pax-heavy-output"),
      "--allowed-root",
      "candidate",
      "--max-members",
      "2000",
    ]);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ members: 1_202 });
    expect(summary.maxCachedMembers).toBeLessThanOrEqual(1);
  }, 30_000);

  it("rejects sparse archive members before extraction", () => {
    const root = makeTempDir();
    const tarPath = path.join(root, "sparse.tar");
    const archivePath = `${tarPath}.zst`;
    const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    sparse = tarfile.TarInfo("candidate/sparse.bin")
    sparse.size = 1
    sparse.pax_headers = {
        "GNU.sparse.map": "0,1",
        "GNU.sparse.realsize": "2097152",
    }
    archive.addfile(sparse, io.BytesIO(b"x"))
`;
    const tarResult = spawnSync("python3", ["-c", python, tarPath], {
      encoding: "utf8",
    });
    expect(tarResult.status, tarResult.stderr).toBe(0);
    const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);

    expectFailure(
      [
        "extract-zstd",
        archivePath,
        path.join(root, "sparse-output"),
        "--allowed-root",
        "candidate",
      ],
      "unsupported sparse member",
    );
  });

  it("rejects compressed archives over the stream cap and cleans up", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "stream-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-expanded-bytes",
        `${1024 * 1024}`,
        "--max-stream-bytes",
        "1024",
      ],
      "decompressed archive stream exceeds",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects non-zero bytes after the tar end marker", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const tarPath = archive.slice(0, -".zst".length);
    appendFileSync(tarPath, "EXFILTRATED-TRAILER");
    const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archive], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);

    const destination = path.join(root, "trailing-output");
    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "non-zero data after tar end",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a concatenated zstd frame after the tar payload", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const trailerPath = path.join(root, "trailer.txt");
    const trailerArchive = `${trailerPath}.zst`;
    writeFileSync(trailerPath, "EXFILTRATED-CONCATENATED-FRAME");
    const zstdResult = spawnSync("zstd", ["-q", "-f", trailerPath, "-o", trailerArchive], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);
    appendFileSync(archive, readFileSync(trailerArchive));

    const destination = path.join(root, "concatenated-output");
    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "non-zero data after tar end",
    );
    expect(existsSync(destination)).toBe(false);
  });
});
