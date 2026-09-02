import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { resolveRootPathSync } from "../infra/boundary-path.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import type {
  PluginEntryCheck,
  PluginFileCacheEntry,
  PluginJsonCacheResult,
} from "./plugin-cache-files.types.js";
import { bindPluginCacheRoot, getPluginCacheRoot } from "./plugin-cache.js";

const DEFAULT_PLUGIN_METADATA_MAX_BYTES = 16 * 1024 * 1024;

function entryKey(relativePath: string, rejectHardlinks: boolean): string {
  return JSON.stringify([path.normalize(relativePath), rejectHardlinks]);
}

function enforceFileSize(entry: PluginFileCacheEntry, maxBytes?: number): PluginFileCacheEntry {
  if (
    entry.ok &&
    maxBytes !== undefined &&
    Math.max(entry.signature.size, entry.contents.length) > maxBytes
  ) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "validation",
        error: new FsSafeError("too-large", `File exceeds ${maxBytes} bytes: ${entry.path}`),
      },
    };
  }
  return entry;
}

function pathFacts(targetPath: string) {
  const absolute = path.resolve(targetPath);
  const root = getPluginCacheRoot(path.dirname(absolute));
  const key = path.basename(absolute);
  let facts = root.paths.get(key);
  if (!facts) {
    facts = {};
    root.paths.set(key, facts);
  }
  return facts;
}

export function pluginCacheExistsSync(targetPath: string): boolean {
  const facts = pathFacts(targetPath);
  return (facts.exists ??= fs.existsSync(targetPath));
}

export function pluginCacheRealpathSync(targetPath: string, native = false): string | null {
  const facts = pathFacts(targetPath);
  const key = native ? "nativeRealpath" : "realpath";
  if (facts[key] === undefined) {
    try {
      facts[key] = native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
      pathFacts(facts[key])[key] = facts[key];
    } catch {
      facts[key] = null;
    }
  }
  return facts[key];
}

/** A trusted owner that changes permissions replaces its own observed stat. */
export function refreshPluginCacheStat(targetPath: string): fs.Stats | null {
  pathFacts(targetPath).stat = undefined;
  return pluginCacheStatSync(targetPath);
}

export function pluginCacheStatSync(targetPath: string): fs.Stats | null {
  const facts = pathFacts(targetPath);
  if (facts.stat === undefined) {
    try {
      facts.stat = fs.statSync(targetPath);
      facts.exists = true;
    } catch {
      facts.stat = null;
    }
  }
  return facts.stat;
}

/** Final symlink checks must retain lstat facts separately from followed target stats. */
export function pluginCacheLstatSync(targetPath: string): fs.Stats | null {
  const facts = pathFacts(targetPath);
  if (facts.lstat === undefined) {
    try {
      facts.lstat = fs.lstatSync(targetPath);
    } catch {
      facts.lstat = null;
    }
  }
  return facts.lstat;
}

export function readPluginCacheDirectory(targetPath: string): fs.Dirent[] {
  const root = getPluginCacheRoot(targetPath);
  if (!root.directory) {
    try {
      root.directory = { ok: true, entries: fs.readdirSync(targetPath, { withFileTypes: true }) };
    } catch (error) {
      root.directory = { ok: false, error };
    }
  }
  if (!root.directory.ok) {
    throw root.directory.error;
  }
  return root.directory.entries;
}

/** Discovery validation is immutable metadata; actual imports validate their own file identity. */
export function checkPluginCacheEntry(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks: boolean;
  rootRealPath?: string;
}): PluginEntryCheck {
  let root = getPluginCacheRoot(params.rootDir);
  const key = entryKey(params.relativePath, params.rejectHardlinks);
  const cached = root.checkedEntries.get(key);
  if (cached) {
    return cached;
  }
  const absolutePath = path.resolve(params.rootDir, params.relativePath);
  let checked: PluginEntryCheck;
  if (!pluginCacheExistsSync(absolutePath)) {
    try {
      const resolved = resolveRootPathSync({
        absolutePath,
        rootPath: params.rootDir,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: "plugin package directory",
      });
      root = bindPluginCacheRoot(params.rootDir, resolved.rootCanonicalPath);
      checked = {
        ok: true,
        path: resolved.canonicalPath,
        rootRealPath: resolved.rootCanonicalPath,
        exists: false,
      };
    } catch (error) {
      checked = { ok: false, reason: "validation", error };
    }
  } else {
    const opened = openRootFileSync({
      absolutePath,
      rootPath: params.rootDir,
      rootRealPath: params.rootRealPath,
      boundaryLabel: "plugin package directory",
      rejectHardlinks: params.rejectHardlinks,
    });
    if (!opened.ok) {
      checked = opened;
    } else {
      fs.closeSync(opened.fd);
      root = bindPluginCacheRoot(params.rootDir, opened.rootRealPath);
      Object.assign(pathFacts(opened.path), { exists: true, stat: opened.stat });
      checked = { ok: true, path: opened.path, rootRealPath: opened.rootRealPath, exists: true };
    }
  }
  root.checkedEntries.set(key, checked);
  return checked;
}

/** Reads metadata once under its original boundary policy, including absence and invalid files. */
export function readPluginCacheFile(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks: boolean;
  rootRealPath?: string;
  /** null preserves the uncapped bundle JSON contract; ordinary metadata stays bounded. */
  maxBytes?: number | null;
}): PluginFileCacheEntry {
  const lexicalRoot = path.resolve(params.rootDir);
  let root = getPluginCacheRoot(lexicalRoot);
  const maxBytes =
    params.maxBytes === null ? undefined : (params.maxBytes ?? DEFAULT_PLUGIN_METADATA_MAX_BYTES);
  const key = entryKey(params.relativePath, params.rejectHardlinks);
  const limitKey = JSON.stringify([key, maxBytes]);
  // A successful strict check also satisfies the bundled/raw-reader policy;
  // its failures never stand in for a more permissive read.
  const strictKey = entryKey(params.relativePath, true);
  const strict = params.rejectHardlinks ? undefined : root.files.get(strictKey);
  const cached =
    root.files.get(key) ?? root.files.get(limitKey) ?? (strict?.ok ? strict : undefined);
  if (cached) {
    return enforceFileSize(cached, maxBytes);
  }
  const requestedPath = path.resolve(lexicalRoot, params.relativePath);
  const checked = root.checkedEntries.get(entryKey(params.relativePath, params.rejectHardlinks));
  if (pathFacts(requestedPath).exists === false || (checked && (!checked.ok || !checked.exists))) {
    const entry: PluginFileCacheEntry = {
      ok: false,
      failure: checked && !checked.ok ? checked : { ok: false, reason: "path" },
    };
    root.files.set(key, entry);
    return entry;
  }
  const canonicalRoot = params.rootRealPath ?? pluginCacheRealpathSync(lexicalRoot) ?? lexicalRoot;
  const canonicalCached = getPluginCacheRoot(canonicalRoot).files.get(key);
  if (canonicalCached?.ok) {
    bindPluginCacheRoot(lexicalRoot, canonicalRoot);
    return enforceFileSize(canonicalCached, maxBytes);
  }
  const absolutePath = path.resolve(canonicalRoot, params.relativePath);
  const opened = openRootFileSync({
    absolutePath,
    rootPath: canonicalRoot,
    rootRealPath: canonicalRoot,
    boundaryLabel: "plugin root",
    rejectHardlinks: params.rejectHardlinks,
    maxBytes,
  });
  let entry: PluginFileCacheEntry;
  if (!opened.ok) {
    entry = { ok: false, failure: opened };
    if (
      opened.reason === "path" &&
      opened.error &&
      typeof opened.error === "object" &&
      "code" in opened.error &&
      opened.error.code === "ENOENT"
    ) {
      pathFacts(requestedPath).exists = false;
      pathFacts(absolutePath).exists = false;
    }
  } else {
    root = bindPluginCacheRoot(lexicalRoot, opened.rootRealPath);
    try {
      const contents =
        maxBytes === undefined
          ? fs.readFileSync(opened.fd)
          : readFileDescriptorBoundedSync(opened.fd, maxBytes);
      entry = {
        ok: true,
        path: opened.path,
        rootRealPath: opened.rootRealPath,
        contents,
        hash: crypto.createHash("sha256").update(contents).digest("hex"),
        signature: {
          size: opened.stat.size,
          mtimeMs: opened.stat.mtimeMs,
          ctimeMs: opened.stat.ctimeMs,
        },
      };
      Object.assign(pathFacts(absolutePath), { exists: true, stat: opened.stat });
      root.checkedEntries.set(entryKey(params.relativePath, params.rejectHardlinks), {
        ok: true,
        path: opened.path,
        rootRealPath: opened.rootRealPath,
        exists: true,
      });
    } catch (error) {
      entry = {
        ok: false,
        failure: { ok: false, reason: "io", error },
        failurePhase: "read",
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  // fs-safe can report size rejection as a generic validation failure. Only successful
  // bytes satisfy other limits; failures retain the policy under which they were checked.
  root.files.set(entry.ok ? key : limitKey, entry);
  return entry;
}

/** Catalog files retain the regular-file policy, which rejects final symlinks but allows hardlinks. */
function readPluginCacheRegularFile(params: {
  filePath: string;
  maxBytes?: number;
}): PluginFileCacheEntry {
  const absolutePath = path.resolve(params.filePath);
  const lexicalRoot = path.dirname(absolutePath);
  const canonicalRoot = pluginCacheRealpathSync(lexicalRoot) ?? lexicalRoot;
  const root = bindPluginCacheRoot(lexicalRoot, canonicalRoot);
  const filename = path.basename(absolutePath);
  const key = JSON.stringify(["regular", filename]);
  const limitKey = JSON.stringify(["regular", filename, params.maxBytes]);
  let entry = root.files.get(key) ?? root.files.get(limitKey);
  // Absence is shared across reader policies; successful reads still require each policy's checks.
  if (!entry && pathFacts(absolutePath).exists === false) {
    entry = { ok: false, failure: { ok: false, reason: "path" } };
    root.files.set(key, entry);
  }
  if (!entry) {
    try {
      const { buffer: contents, stat } = readRegularFileSync({
        filePath: absolutePath,
        maxBytes: params.maxBytes,
      });
      entry = {
        ok: true,
        path: path.join(canonicalRoot, filename),
        rootRealPath: canonicalRoot,
        contents,
        hash: crypto.createHash("sha256").update(contents).digest("hex"),
        signature: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
      };
      Object.assign(pathFacts(absolutePath), { exists: true, stat });
      root.files.set(key, entry);
    } catch (error) {
      entry = { ok: false, failure: { ok: false, reason: "io", error } };
      // A size rejection cannot stand in for an uncapped reader's policy.
      root.files.set(
        error instanceof FsSafeError && error.code === "too-large" ? limitKey : key,
        entry,
      );
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        pathFacts(absolutePath).exists = false;
      }
    }
  }
  if (
    entry.ok &&
    params.maxBytes !== undefined &&
    Math.max(entry.signature.size, entry.contents.length) > params.maxBytes
  ) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "io",
        error: new FsSafeError(
          "too-large",
          `File exceeds ${params.maxBytes} bytes: ${absolutePath}`,
        ),
      },
    };
  }
  return entry;
}

export function readPluginCacheJsonFile(
  filePath: string,
  options: { maxBytes?: number } = {},
): PluginJsonCacheResult {
  const file = readPluginCacheRegularFile({ filePath, ...options });
  return file.ok ? parsePluginCacheJson(file) : { ok: false, error: file.failure.error };
}

export function parsePluginCacheJson(
  file: Extract<PluginFileCacheEntry, { ok: true }>,
  options: { json5?: boolean } = {},
): PluginJsonCacheResult {
  const key = options.json5 ? "json5" : "json";
  if (!file[key]) {
    try {
      const source = file.contents.toString("utf8");
      file[key] = {
        ok: true,
        value: options.json5 ? parseJsonWithJson5Fallback(source) : JSON.parse(source),
      };
    } catch (error) {
      file[key] = { ok: false, error };
    }
  }
  return file[key];
}
