import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/swift-build-cache-metadata.py");
const originalTime = 1_700_000_000_123_456_789n;
const checkoutTime = originalTime + 10_000_000_123n;
const sourcePath = "apps/macos/Sources/Feature.swift";
const metadataPath = "apps/macos/.build/ci-input-metadata.json";
const sourceDigest = createHash("sha256").update("source\n").digest("hex");

function run(root: string, mode: "record" | "restore") {
  const result = spawnSync("python3", ["-I", "-S", script, mode], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

function writeInput(root: string, relative: string, content = "source\n") {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function setTime(time: bigint, ...files: string[]) {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      "import os,sys\nfor file in sys.argv[2:]: os.utime(file, ns=(int(sys.argv[1]),)*2)",
      String(time),
      ...files,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
}

function fixture() {
  const root = tempDirs.make("openclaw-swift-cache-metadata-");
  mkdirSync(path.join(root, "apps/macos/.build"), { recursive: true });
  const source = writeInput(root, sourcePath);
  chmodSync(source, 0o644);
  setTime(originalTime, source);
  return { root, source, metadata: path.join(root, metadataPath) };
}

describe.skipIf(process.platform === "win32")("Swift build-cache input metadata", () => {
  it("restores original nanoseconds only for byte-identical current inputs", () => {
    const { root, source, metadata } = fixture();
    const sharedFixture =
      "apps/shared/OpenClawKit/Tests/OpenClawKitTests/GatewayTLSStoreFixture.swift";
    const unchanged = [
      sourcePath,
      "apps/macos/Tests/FeatureTests.swift",
      "apps/shared/OpenClawKit/Sources/Shared.swift",
      "apps/shared/OpenClawMLXTTSProtocol/Sources/OpenClawMLXTTSProtocol/MLXTTSProtocol.swift",
      sharedFixture,
      "apps/swabble/Sources/Voice.swift",
      "apps/macos/.build/checkouts/dependency/Sources/Library.swift",
      "apps/macos/Package.swift",
      "apps/macos/Package.resolved",
      "apps/shared/OpenClawKit/Package.swift",
      "apps/shared/OpenClawMLXTTSProtocol/Package.swift",
      "apps/swabble/Package.swift",
    ];
    setTime(originalTime, ...unchanged.slice(1).map((relative) => writeInput(root, relative)));
    const sharedFixtureLink = path.join(
      root,
      "apps/macos/Tests/OpenClawIPCTests/GatewayTLSStoreFixture.swift",
    );
    mkdirSync(path.dirname(sharedFixtureLink), { recursive: true });
    symlinkSync(
      path.relative(path.dirname(sharedFixtureLink), path.join(root, sharedFixture)),
      sharedFixtureLink,
    );
    const changed = writeInput(root, "apps/macos/Sources/Changed.swift", "before\n");
    const modeChanged = writeInput(root, "apps/macos/Sources/ModeChanged.swift");
    chmodSync(modeChanged, 0o644);
    const removed = writeInput(root, "apps/macos/Sources/Removed.swift");
    run(root, "record");
    const archive = readFileSync(metadata);
    const inode = statSync(source, { bigint: true }).ino;
    for (const relative of unchanged) {
      const file = path.join(root, relative);
      const mode = statSync(file).mode & 0o7777;
      writeFileSync(`${file}.replacement`, readFileSync(file), { mode });
      // File creation applies umask even when mode is explicit.
      chmodSync(`${file}.replacement`, mode);
      renameSync(`${file}.replacement`, file);
    }
    expect(statSync(source, { bigint: true }).ino).not.toBe(inode);
    writeFileSync(changed, "after!\n");
    chmodSync(modeChanged, 0o600);
    rmSync(removed);
    const added = writeInput(root, "apps/macos/Sources/Added.swift");
    setTime(
      checkoutTime,
      ...unchanged.map((relative) => path.join(root, relative)),
      changed,
      modeChanged,
      added,
    );
    writeFileSync(metadata, archive);

    expect(run(root, "restore")).toContain("12 verified input timestamps");
    for (const relative of unchanged) {
      expect(statSync(path.join(root, relative), { bigint: true }).mtimeNs).toBe(originalTime);
    }
    expect(lstatSync(sharedFixtureLink).isSymbolicLink()).toBe(true);
    expect(statSync(sharedFixtureLink, { bigint: true }).mtimeNs).toBe(originalTime);
    for (const file of [changed, modeChanged, added]) {
      expect(statSync(file, { bigint: true }).mtimeNs).toBe(checkoutTime);
    }
    expect(readFileSync(changed, "utf8")).toBe("after!\n");
    expect(() => statSync(removed)).toThrow();
  });

  it.each([
    "{",
    "null",
    '{"version":2,"files":{}}',
    '{"version":1,"files":[]}',
    JSON.stringify({
      version: 1,
      files: { [sourcePath]: { sha256: "not-a-digest", mode: 0o644, mtime_ns: 1 } },
    }),
    JSON.stringify({
      version: 1,
      files: { [sourcePath]: { sha256: sourceDigest, mode: 0o644, mtime_ns: true } },
    }),
  ])("leaves checkout metadata unchanged for unusable cache metadata: %s", (artifact) => {
    const { root, source, metadata } = fixture();
    writeFileSync(metadata, artifact);
    run(root, "restore");
    expect(statSync(source, { bigint: true }).mtimeNs).toBe(originalTime);
  });

  it("cannot replay arbitrary paths, source links, hardlinks, or a linked cache artifact", () => {
    const { root, source, metadata } = fixture();
    run(root, "record");
    const artifact = JSON.parse(readFileSync(metadata, "utf8"));
    const outside = tempDirs.make("openclaw-swift-cache-outside-");
    const external = writeInput(outside, "Feature.swift");
    for (const relative of [
      external,
      `../${path.basename(outside)}/Feature.swift`,
      "other.swift",
    ]) {
      artifact.files[relative] = artifact.files[sourcePath];
    }
    setTime(checkoutTime, external, writeInput(root, "other.swift"));
    rmSync(source);
    symlinkSync(external, source);
    symlinkSync(outside, path.join(root, "apps/macos/Sources/linked-directory"), "dir");
    linkSync(external, path.join(root, "apps/macos/Sources/Hardlink.swift"));
    artifact.files["apps/macos/Sources/linked-directory/Feature.swift"] =
      artifact.files[sourcePath];
    artifact.files["apps/macos/Sources/Hardlink.swift"] = artifact.files[sourcePath];
    writeFileSync(metadata, JSON.stringify(artifact));
    run(root, "restore");
    expect(statSync(external, { bigint: true }).mtimeNs).toBe(checkoutTime);
    expect(statSync(path.join(root, "other.swift"), { bigint: true }).mtimeNs).toBe(checkoutTime);

    rmSync(source);
    writeInput(root, sourcePath);
    setTime(checkoutTime, source);
    const linkedMetadata = writeInput(outside, "metadata.json", JSON.stringify(artifact));
    rmSync(metadata);
    symlinkSync(linkedMetadata, metadata);
    run(root, "restore");
    expect(statSync(source, { bigint: true }).mtimeNs).toBe(checkoutTime);
    run(root, "record");
    expect(readFileSync(linkedMetadata, "utf8")).toBe(JSON.stringify(artifact));
    expect(JSON.parse(readFileSync(metadata, "utf8")).files).toHaveProperty([sourcePath]);
    rmSync(path.dirname(source), { recursive: true });
    symlinkSync(outside, path.dirname(source), "dir");
    run(root, "restore");
    expect(statSync(external, { bigint: true }).mtimeNs).toBe(checkoutTime);
  });

  it("lets absent metadata or a reset build directory invalidate normally", () => {
    const { root, source, metadata } = fixture();
    run(root, "restore");
    rmSync(path.dirname(metadata), { recursive: true });
    run(root, "restore");
    expect(statSync(source, { bigint: true }).mtimeNs).toBe(originalTime);
  });
});
