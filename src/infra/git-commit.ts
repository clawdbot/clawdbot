// Resolves git commit metadata for build/runtime diagnostics.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { readFileWindowFullySync } from "./file-read.js";
import { resolveGitHeadPath } from "./git-root.js";
import { pruneMapToMaxSize } from "./map-size.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";

const formatCommit = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/[0-9a-fA-F]{7,40}/);
  if (!match) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(match[0].slice(0, 7));
};

const cachedGitCommitBySearchDir = new Map<string, string | null>();
const GIT_COMMIT_CACHE_LIMIT = 256;

type CommitMetadataReaders = {
  readGitCommit?: (searchDir: string, packageRoot: string | null) => string | null | undefined;
  readBuildInfoCommit?: () => string | null;
  readPackageJsonCommit?: () => string | null;
};

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

const resolveCommitSearchDir = (options: { cwd?: string; moduleUrl?: string }) => {
  if (options.cwd) {
    return path.resolve(options.cwd);
  }
  if (options.moduleUrl) {
    try {
      return path.dirname(fileURLToPath(options.moduleUrl));
    } catch {
      // moduleUrl is not a valid file:// URL; fall back to process.cwd().
    }
  }
  return process.cwd();
};

/** Read at most `limit` bytes from a file to avoid unbounded reads. */
const safeReadFilePrefix = (filePath: string, limit = 256) => {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(limit);
    const bytesRead = readFileWindowFullySync(fd, buf, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
};

const cacheGitCommit = (searchDir: string, commit: string | null) => {
  cachedGitCommitBySearchDir.set(searchDir, commit);
  pruneMapToMaxSize(cachedGitCommitBySearchDir, GIT_COMMIT_CACHE_LIMIT);
  return commit;
};
const resolveGitLookupDepth = (searchDir: string, packageRoot: string | null) => {
  if (!packageRoot) {
    return undefined;
  }
  const relative = path.relative(packageRoot, searchDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  const depth = relative ? relative.split(path.sep).filter(Boolean).length : 0;
  return depth + 1;
};

const readCommitFromGit = (
  searchDir: string,
  packageRoot: string | null,
): string | null | undefined => {
  const headPath = resolveGitHeadPath(searchDir, {
    maxDepth: resolveGitLookupDepth(searchDir, packageRoot),
  });
  if (!headPath) {
    return undefined;
  }
  const head = fs.readFileSync(headPath, "utf-8").trim();
  if (!head) {
    return null;
  }
  if (head.startsWith("ref:")) {
    const ref = head.replace(/^ref:\s*/i, "").trim();
    const refsBase = resolveGitRefsBase(headPath);
    const refPath = resolveRefPath(refsBase, ref);
    if (!refPath) {
      return null;
    }
    try {
      const refHash = safeReadFilePrefix(refPath).trim();
      return formatCommit(refHash);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    return readCommitFromPackedRefs(refsBase, ref);
  }
  return formatCommit(head);
};

const resolveGitRefsBase = (headPath: string) => {
  const gitDir = path.dirname(headPath);
  try {
    const commonDir = safeReadFilePrefix(path.join(gitDir, "commondir")).trim();
    if (commonDir) {
      return path.resolve(gitDir, commonDir);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    // Plain repo git dirs do not have commondir.
  }
  return gitDir;
};

const readCommitFromPackedRefs = (refsBase: string, ref: string) => {
  try {
    const packedRefs = fs.readFileSync(path.join(refsBase, "packed-refs"), "utf-8");
    for (const line of packedRefs.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }
      const [commit, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef === ref) {
        return formatCommit(commit);
      }
    }
    return null;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    return null;
  }
};

/** Safely resolve a git ref path, rejecting traversal attacks from a crafted HEAD file. */
const resolveRefPath = (refsBase: string, ref: string) => {
  if (!ref.startsWith("refs/")) {
    return null;
  }
  if (path.isAbsolute(ref)) {
    return null;
  }
  if (ref.split(/[/]/).includes("..")) {
    return null;
  }
  const resolved = path.resolve(refsBase, ref);
  const rel = path.relative(refsBase, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
};

const readCommitFromPackageJson = () => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as {
      gitHead?: string;
      githead?: string;
    };
    return formatCommit(pkg.gitHead ?? pkg.githead ?? null);
  } catch {
    return null;
  }
};

const readCommitFromBuildInfo = () => {
  try {
    const require = createRequire(import.meta.url);
    const candidates = ["../build-info.json", "./build-info.json"];
    for (const candidate of candidates) {
      try {
        const info = require(candidate) as {
          commit?: string | null;
        };
        const formatted = formatCommit(info.commit ?? null);
        if (formatted) {
          return formatted;
        }
      } catch {
        // ignore missing candidate
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const resolveCommitHash = (
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
    readers?: CommitMetadataReaders;
  } = {},
) => {
  const env = options.env ?? process.env;
  const readers = options.readers ?? {};
  const readGitCommit = readers.readGitCommit ?? readCommitFromGit;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const normalized = formatCommit(envCommit);
  if (normalized) {
    return normalized;
  }
  const searchDir = resolveCommitSearchDir(options);
  if (cachedGitCommitBySearchDir.has(searchDir)) {
    const cached = cachedGitCommitBySearchDir.get(searchDir) ?? null;
    // Git discovery reads multiple files; keep active directories ahead of cold entries when
    // the shared insertion-order pruning helper enforces the bound.
    cachedGitCommitBySearchDir.delete(searchDir);
    cachedGitCommitBySearchDir.set(searchDir, cached);
    return cached;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    cwd: options.cwd,
    moduleUrl: options.moduleUrl,
  });
  try {
    const gitCommit = readGitCommit(searchDir, packageRoot);
    if (gitCommit !== undefined) {
      return cacheGitCommit(searchDir, gitCommit);
    }
  } catch {
    // Fall through to baked metadata for packaged installs that are not in a live checkout.
  }
  const buildInfoCommit = readers.readBuildInfoCommit?.() ?? readCommitFromBuildInfo();
  if (buildInfoCommit) {
    return cacheGitCommit(searchDir, buildInfoCommit);
  }
  const pkgCommit = readers.readPackageJsonCommit?.() ?? readCommitFromPackageJson();
  if (pkgCommit) {
    return cacheGitCommit(searchDir, pkgCommit);
  }
  try {
    return cacheGitCommit(searchDir, readGitCommit(searchDir, packageRoot) ?? null);
  } catch {
    return cacheGitCommit(searchDir, null);
  }
};
