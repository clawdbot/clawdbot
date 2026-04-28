import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  if (path.resolve(params.sourceRoot) === path.resolve(params.targetRoot)) {
    return false;
  }
  const metadata = createBundledRuntimeMirrorMetadata(params, params.precomputedSourceMetadata);
  if (isBundledRuntimeMirrorRootFresh(params.targetRoot, metadata)) {
    return false;
  }
  const tempDir = fs.mkdtempSync(
    path.join(
      params.tempDirParent ?? path.dirname(params.targetRoot),
      `.plugin-${sanitizeBundledRuntimeMirrorTempId(params.pluginId)}-`,
    ),
  );
  const stagedRoot = path.join(tempDir, "plugin");
  try {
    copyBundledPluginRuntimeRoot(params.sourceRoot, stagedRoot);
    writeBundledRuntimeMirrorMetadata(stagedRoot, metadata);
    fs.rmSync(params.targetRoot, { recursive: true, force: true });
    fs.renameSync(stagedRoot, params.targetRoot);
    return true;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function copyBundledPluginRuntimeRoot(sourceRoot: string, targetRoot: string): void {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) {
    return;
  }
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (shouldIgnoreBundledRuntimeMirrorEntry(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      copyBundledPluginRuntimeRoot(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
    try {
      const sourceMode = fs.statSync(sourcePath).mode;
      fs.chmodSync(targetPath, sourceMode | 0o600);
    } catch {
      // Readable copied files are enough for plugin loading.
    }
  }
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
  const hash = createHash("sha256");
  hashBundledRuntimeMirrorDirectory(hash, sourceRoot, sourceRoot);
  return hash.digest("hex");
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

function sanitizeBundledRuntimeMirrorTempId(pluginId: string): string {
  return pluginId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}
