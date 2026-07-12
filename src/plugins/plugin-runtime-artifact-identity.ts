/** Computes a bounded content identity for plugin-owned runtime artifacts. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { walkDirectorySync } from "../infra/fs-safe.js";
import type { OpenClawPackageBuild } from "./manifest.js";
import { safeRealpathSync } from "./path-safety.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePluginRuntimeArtifact } from "./plugin-runtime-artifact-resolution.js";

const MAX_RUNTIME_ARTIFACT_DEPTH = 64;
const MAX_RUNTIME_ARTIFACT_ENTRIES = 50_000;
const MAX_RUNTIME_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_ARTIFACT_TOTAL_BYTES = 512 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const EXCLUDED_RUNTIME_ARTIFACT_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

export type PluginRuntimeArtifactIdentitySource = Readonly<{
  pluginId: string;
  origin: PluginOrigin;
  rootDir: string;
  source?: string;
  packageBuild?: OpenClawPackageBuild;
}>;

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function listRuntimeArtifactFiles(rootDir: string): string[] {
  const scan = walkDirectorySync(rootDir, {
    maxDepth: MAX_RUNTIME_ARTIFACT_DEPTH,
    maxEntries: MAX_RUNTIME_ARTIFACT_ENTRIES,
    symlinks: "include",
    descend: (entry) => !EXCLUDED_RUNTIME_ARTIFACT_DIRECTORIES.has(entry.name),
    include: (entry) =>
      entry.kind !== "directory" && !EXCLUDED_RUNTIME_ARTIFACT_DIRECTORIES.has(entry.name),
  });
  if (scan.truncated) {
    throw new Error("plugin runtime artifact exceeds the bounded file scan");
  }
  if ((scan.failedDirs?.length ?? 0) > 0) {
    throw new Error("plugin runtime artifact contains an unreadable directory");
  }
  return scan.entries
    .map((entry) => {
      if (entry.kind !== "file") {
        throw new Error(`plugin runtime artifact contains unsupported ${entry.kind} entry`);
      }
      return normalizeRelativePath(entry.relativePath);
    })
    .toSorted();
}

function sameOpenedFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function hashRuntimeArtifactFile(params: {
  rootDir: string;
  rootRealPath: string;
  relativePath: string;
}): { hash: string; size: number; mode: number } {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openRootFileSync({
    absolutePath,
    rootPath: params.rootDir,
    rootRealPath: params.rootRealPath,
    boundaryLabel: "plugin runtime artifact",
    maxBytes: MAX_RUNTIME_ARTIFACT_FILE_BYTES,
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`plugin runtime artifact file is not readable: ${params.relativePath}`);
  }
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < opened.stat.size) {
      const read = fs.readSync(
        opened.fd,
        buffer,
        0,
        Math.min(buffer.length, opened.stat.size - offset),
        offset,
      );
      if (read === 0) {
        throw new Error(
          `plugin runtime artifact file changed while reading: ${params.relativePath}`,
        );
      }
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(opened.fd);
    if (!sameOpenedFile(opened.stat, after)) {
      throw new Error(`plugin runtime artifact file changed while reading: ${params.relativePath}`);
    }
    return { hash: hash.digest("hex"), size: opened.stat.size, mode: opened.stat.mode };
  } finally {
    fs.closeSync(opened.fd);
  }
}

/**
 * Hashes plugin-owned files only. Dependency stores and VCS metadata are
 * separate runtime owners; plugin installs/updates must replace this digest.
 */
export function fingerprintPluginRuntimeArtifact(
  record: PluginRuntimeArtifactIdentitySource,
): string {
  const runtimeArtifact = record.source
    ? resolvePluginRuntimeArtifact({
        source: record.source,
        rootDir: record.rootDir,
        origin: record.origin,
        // Gateway and standalone agent runtimes select built artifacts.
        preferBuiltPluginArtifacts: true,
        ...(record.packageBuild ? { packageManifest: { build: record.packageBuild } } : {}),
      })
    : { rootDir: record.rootDir, source: undefined };
  const rootDir = path.resolve(runtimeArtifact.rootDir);
  const rootRealPath = safeRealpathSync(rootDir);
  if (!rootRealPath) {
    throw new Error(`plugin runtime root is unavailable: ${record.pluginId}`);
  }
  const source = runtimeArtifact.source
    ? path.isAbsolute(runtimeArtifact.source)
      ? runtimeArtifact.source
      : path.resolve(rootRealPath, runtimeArtifact.source)
    : null;
  const sourceRelativePath = source
    ? path.relative(rootRealPath, safeRealpathSync(source) ?? source)
    : null;
  if (
    sourceRelativePath !== null &&
    (sourceRelativePath === ".." ||
      sourceRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(sourceRelativePath))
  ) {
    throw new Error(`plugin runtime entry escapes its root: ${record.pluginId}`);
  }

  const beforeFiles = listRuntimeArtifactFiles(rootRealPath);
  if (
    sourceRelativePath !== null &&
    !beforeFiles.includes(normalizeRelativePath(sourceRelativePath))
  ) {
    throw new Error(`plugin runtime entry is unavailable: ${record.pluginId}`);
  }
  const hash = crypto.createHash("sha256");
  hash.update("openclaw-plugin-runtime-artifact-v1\0");
  hash.update(sourceRelativePath ? normalizeRelativePath(sourceRelativePath) : "<no-source>");
  hash.update("\0");
  let totalBytes = 0;
  for (const relativePath of beforeFiles) {
    const file = hashRuntimeArtifactFile({ rootDir: rootRealPath, rootRealPath, relativePath });
    totalBytes += file.size;
    if (totalBytes > MAX_RUNTIME_ARTIFACT_TOTAL_BYTES) {
      throw new Error("plugin runtime artifact exceeds the bounded content scan");
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(file.mode));
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.hash);
    hash.update("\0");
  }
  const afterFiles = listRuntimeArtifactFiles(rootRealPath);
  if (
    beforeFiles.length !== afterFiles.length ||
    beforeFiles.some((file, i) => file !== afterFiles[i])
  ) {
    throw new Error("plugin runtime artifact changed while reading");
  }
  return hash.digest("hex");
}
