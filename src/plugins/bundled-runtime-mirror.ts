import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";

const BUNDLED_RUNTIME_MIRROR_METADATA_FILE = ".openclaw-runtime-mirror.json";
const BUNDLED_RUNTIME_MIRROR_METADATA_VERSION = 1;

type BundledRuntimeMirrorMetadata = {
  version: number;
  pluginId: string;
  sourceRoot: string;
  sourceFingerprint: string;
};

export type PrecomputedBundledRuntimeMirrorMetadata = Pick<
  BundledRuntimeMirrorMetadata,
  "sourceRoot" | "sourceFingerprint"
>;

export function refreshBundledPluginRuntimeMirrorRoot(params: {
  pluginId: string;
  sourceRoot: string;
  targetRoot: string;
  tempDirParent?: string;
  precomputedSourceMetadata?: PrecomputedBundledRuntimeMirrorMetadata;
}): boolean {
  return tracePluginLifecyclePhase(
    "runtime mirror refresh",
    () => {
      if (path.resolve(params.sourceRoot) === path.resolve(params.targetRoot)) {
        return false;
      }
      const metadata = createBundledRuntimeMirrorMetadata(params, params.precomputedSourceMetadata);
      if (isBundledRuntimeMirrorRootFresh(params.targetRoot, metadata)) {
        return false;
      }
      copyBundledPluginRuntimeRoot(params.sourceRoot, params.targetRoot);
      writeBundledRuntimeMirrorMetadata(params.targetRoot, metadata);
      return true;
    },
    { pluginId: params.pluginId },
  );
}

export function copyBundledPluginRuntimeRoot(sourceRoot: string, targetRoot: string): void {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) {
    return;
  }
  ensureBundledRuntimeMirrorDirectory(targetRoot);
  const mirroredNames = new Set<string>();
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (shouldIgnoreBundledRuntimeMirrorEntry(entry.name)) {
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink() && !entry.isFile()) {
      continue;
    }
    mirroredNames.add(entry.name);
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      removeBundledRuntimeMirrorPathIfTypeChanged(targetPath, "directory");
      copyBundledPluginRuntimeRoot(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      removeBundledRuntimeMirrorPathIfTypeChanged(targetPath, "symlink");
      replaceBundledRuntimeMirrorSymlinkAtomic(fs.readlinkSync(sourcePath), targetPath);
      continue;
    }
    removeBundledRuntimeMirrorPathIfTypeChanged(targetPath, "file");
    copyBundledRuntimeMirrorFileAtomic(sourcePath, targetPath);
    chmodBundledRuntimeMirrorFileReadable(sourcePath, targetPath);
  }
  pruneStaleBundledRuntimeMirrorEntries(targetRoot, mirroredNames);
}

export function materializeBundledRuntimeMirrorFile(sourcePath: string, targetPath: string): void {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }
  try {
    if (isBundledRuntimeMirrorFileAlreadyMaterialized(sourcePath, targetPath)) {
      return;
    }
  } catch {
    // Missing targets are expected before the mirror file is materialized.
  }
  ensureBundledRuntimeMirrorDirectory(path.dirname(targetPath));
  removeBundledRuntimeMirrorPathIfTypeChanged(targetPath, "file");
  const tempPath = createBundledRuntimeMirrorTempPath(targetPath);
  try {
    try {
      fs.linkSync(sourcePath, tempPath);
    } catch {
      fs.copyFileSync(sourcePath, tempPath);
      chmodBundledRuntimeMirrorFileReadable(sourcePath, tempPath);
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function isBundledRuntimeMirrorFileAlreadyMaterialized(
  sourcePath: string,
  targetPath: string,
): boolean {
  const sourceStat = fs.lstatSync(sourcePath);
  const targetStat = fs.lstatSync(targetPath);
  return (
    sourceStat.isFile() &&
    targetStat.isFile() &&
    sourceStat.dev === targetStat.dev &&
    sourceStat.ino === targetStat.ino
  );
}
function chmodBundledRuntimeMirrorFileReadable(sourcePath: string, targetPath: string): void {
  try {
    const sourceMode = fs.statSync(sourcePath).mode;
    fs.chmodSync(targetPath, sourceMode | 0o600);
  } catch {
    // Readable mirrored files are enough for plugin loading.
  }
}

function pruneStaleBundledRuntimeMirrorEntries(
  targetRoot: string,
  mirroredNames: Set<string>,
): void {
  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (shouldIgnoreBundledRuntimeMirrorEntry(entry.name)) {
      continue;
    }
    if (mirroredNames.has(entry.name)) {
      continue;
    }
    fs.rmSync(path.join(targetRoot, entry.name), { recursive: true, force: true });
  }
}

function ensureBundledRuntimeMirrorDirectory(targetRoot: string): void {
  try {
    const stat = fs.lstatSync(targetRoot);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return;
    }
    fs.rmSync(targetRoot, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
}

function removeBundledRuntimeMirrorPathIfTypeChanged(
  targetPath: string,
  expectedType: "directory" | "file" | "symlink",
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return;
  }
  const matches =
    expectedType === "directory"
      ? stat.isDirectory()
      : expectedType === "symlink"
        ? stat.isSymbolicLink()
        : stat.isFile();
  if (!matches) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function replaceBundledRuntimeMirrorSymlinkAtomic(linkTarget: string, targetPath: string): void {
  ensureBundledRuntimeMirrorDirectory(path.dirname(targetPath));
  const tempPath = createBundledRuntimeMirrorTempPath(targetPath);
  try {
    fs.symlinkSync(linkTarget, tempPath);
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function copyBundledRuntimeMirrorFileAtomic(sourcePath: string, targetPath: string): void {
  ensureBundledRuntimeMirrorDirectory(path.dirname(targetPath));
  const tempPath = createBundledRuntimeMirrorTempPath(targetPath);
  try {
    fs.copyFileSync(sourcePath, tempPath);
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function createBundledRuntimeMirrorTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.openclaw-mirror-${process.pid}-${process.hrtime.bigint()}-${path.basename(targetPath)}.tmp`,
  );
}

export function precomputeBundledRuntimeMirrorMetadata(params: {
  sourceRoot: string;
}): PrecomputedBundledRuntimeMirrorMetadata {
  return {
    sourceRoot: resolveBundledRuntimeMirrorSourceRootId(params.sourceRoot),
    sourceFingerprint: fingerprintBundledRuntimeMirrorSourceRoot(params.sourceRoot),
  };
}

function createBundledRuntimeMirrorMetadata(
  params: {
    pluginId: string;
    sourceRoot: string;
  },
  precomputedSourceMetadata?: PrecomputedBundledRuntimeMirrorMetadata,
): BundledRuntimeMirrorMetadata {
  const sourceRoot = resolveBundledRuntimeMirrorSourceRootId(params.sourceRoot);
  return {
    version: BUNDLED_RUNTIME_MIRROR_METADATA_VERSION,
    pluginId: params.pluginId,
    sourceRoot,
    sourceFingerprint:
      precomputedSourceMetadata?.sourceRoot === sourceRoot
        ? precomputedSourceMetadata.sourceFingerprint
        : fingerprintBundledRuntimeMirrorSourceRoot(params.sourceRoot),
  };
}

function isBundledRuntimeMirrorRootFresh(
  targetRoot: string,
  expected: BundledRuntimeMirrorMetadata,
): boolean {
  try {
    if (!fs.lstatSync(targetRoot).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  const actual = readBundledRuntimeMirrorMetadata(targetRoot);
  return (
    actual?.version === expected.version &&
    actual.pluginId === expected.pluginId &&
    actual.sourceRoot === expected.sourceRoot &&
    actual.sourceFingerprint === expected.sourceFingerprint
  );
}

function readBundledRuntimeMirrorMetadata(targetRoot: string): BundledRuntimeMirrorMetadata | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(targetRoot, BUNDLED_RUNTIME_MIRROR_METADATA_FILE), "utf8"),
    ) as Partial<BundledRuntimeMirrorMetadata>;
    if (
      parsed.version !== BUNDLED_RUNTIME_MIRROR_METADATA_VERSION ||
      typeof parsed.pluginId !== "string" ||
      typeof parsed.sourceRoot !== "string" ||
      typeof parsed.sourceFingerprint !== "string"
    ) {
      return null;
    }
    return parsed as BundledRuntimeMirrorMetadata;
  } catch {
    return null;
  }
}

function writeBundledRuntimeMirrorMetadata(
  targetRoot: string,
  metadata: BundledRuntimeMirrorMetadata,
): void {
  fs.writeFileSync(
    path.join(targetRoot, BUNDLED_RUNTIME_MIRROR_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

function fingerprintBundledRuntimeMirrorSourceRoot(sourceRoot: string): string {
  return tracePluginLifecyclePhase(
    "runtime mirror fingerprint",
    () => {
      const hash = createHash("sha256");
      hashBundledRuntimeMirrorDirectory(hash, sourceRoot, sourceRoot);
      return hash.digest("hex");
    },
    { sourceRoot },
  );
}

function hashBundledRuntimeMirrorDirectory(
  hash: ReturnType<typeof createHash>,
  sourceRoot: string,
  directory: string,
): void {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !shouldIgnoreBundledRuntimeMirrorEntry(entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = path.join(directory, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath).replaceAll(path.sep, "/");
    const stat = fs.lstatSync(sourcePath, { bigint: true });
    if (entry.isDirectory()) {
      updateBundledRuntimeMirrorHash(hash, [
        "dir",
        relativePath,
        formatBundledRuntimeMirrorMode(stat.mode),
      ]);
      hashBundledRuntimeMirrorDirectory(hash, sourceRoot, sourcePath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      updateBundledRuntimeMirrorHash(hash, [
        "symlink",
        relativePath,
        formatBundledRuntimeMirrorMode(stat.mode),
        stat.ctimeNs.toString(),
        fs.readlinkSync(sourcePath),
      ]);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    updateBundledRuntimeMirrorHash(hash, [
      "file",
      relativePath,
      formatBundledRuntimeMirrorMode(stat.mode),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.ctimeNs.toString(),
    ]);
  }
}

function updateBundledRuntimeMirrorHash(
  hash: ReturnType<typeof createHash>,
  fields: readonly string[],
): void {
  hash.update(JSON.stringify(fields));
  hash.update("\n");
}

function formatBundledRuntimeMirrorMode(mode: bigint): string {
  return (mode & 0o7777n).toString(8);
}

function resolveBundledRuntimeMirrorSourceRootId(sourceRoot: string): string {
  try {
    return fs.realpathSync.native(sourceRoot);
  } catch {
    return path.resolve(sourceRoot);
  }
}

function shouldIgnoreBundledRuntimeMirrorEntry(name: string): boolean {
  return name === "node_modules" || name === BUNDLED_RUNTIME_MIRROR_METADATA_FILE;
}
