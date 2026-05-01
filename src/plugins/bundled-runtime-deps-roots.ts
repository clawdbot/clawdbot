import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { readRuntimeDepsJsonObject } from "./bundled-runtime-deps-json.js";
import {
  BUNDLED_RUNTIME_DEPS_LOCK_DIR,
  removeRuntimeDepsLockIfStale,
} from "./bundled-runtime-deps-lock.js";

const DEFAULT_UNKNOWN_RUNTIME_DEPS_ROOTS_TO_KEEP = 20;
const DEFAULT_UNKNOWN_RUNTIME_DEPS_MIN_AGE_MS = 10 * 60_000;
const PACKAGE_KEY_PATH_HASH_RE = /^openclaw-.+-([0-9a-f]{12})$/u;
const LEGACY_VERSIONED_RUNTIME_DEPS_ROOT_RE =
  /^openclaw-\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)*-[A-Za-z][A-Za-z0-9_-]*$/u;

export type BundledRuntimeDepsInstallRootPlan = {
  installRoot: string;
  external: boolean;
  searchRoots: string[];
};

export function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    (fs.existsSync(path.join(packageRoot, ".git")) ||
      fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml"))) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function resolveBundledPluginPackageRoot(pluginRoot: string): string | null {
  const extensionsDir = path.dirname(path.resolve(pluginRoot));
  const buildDir = path.dirname(extensionsDir);
  if (
    path.basename(extensionsDir) !== "extensions" ||
    (path.basename(buildDir) !== "dist" && path.basename(buildDir) !== "dist-runtime")
  ) {
    return null;
  }
  return path.dirname(buildDir);
}

export function resolveBundledRuntimeDependencyPackageRoot(pluginRoot: string): string | null {
  return resolveBundledPluginPackageRoot(pluginRoot);
}

function isPackagedBundledPluginRoot(pluginRoot: string): boolean {
  const packageRoot = resolveBundledPluginPackageRoot(pluginRoot);
  return Boolean(packageRoot && !isSourceCheckoutRoot(packageRoot));
}

function createPathHash(value: string): string {
  // Hash the OS-canonical (realpath) form so symlinked / junctioned
  // packageRoots converge on a single staging directory across call sites.
  return createHash("sha256").update(realpathOrResolve(value)).digest("hex").slice(0, 12);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readPackageVersion(packageRoot: string): string {
  const parsed = readRuntimeDepsJsonObject(path.join(packageRoot, "package.json"));
  const version = parsed && typeof parsed.version === "string" ? parsed.version.trim() : "";
  return version || "unknown";
}

export function isWritableDirectory(dir: string): boolean {
  let probeDir: string | null = null;
  try {
    probeDir = fs.mkdtempSync(path.join(dir, ".openclaw-write-probe-"));
    fs.writeFileSync(path.join(probeDir, "probe"), "", "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup. A failed cleanup should not turn a writable
        // probe into a hard runtime-dependency failure.
      }
    }
  }
}

function resolveSystemdStateDirectory(env: NodeJS.ProcessEnv): string | null {
  const raw = env.STATE_DIRECTORY?.trim();
  if (!raw) {
    return null;
  }
  const first = raw.split(path.delimiter).find((entry) => entry.trim().length > 0);
  return first ? path.resolve(first) : null;
}

function resolveBundledRuntimeDepsExternalBaseDirs(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.OPENCLAW_PLUGIN_STAGE_DIR?.trim();
  if (explicit) {
    const roots = explicit
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => path.resolve(resolveHomeRelativePath(entry, { env, homedir: os.homedir })));
    if (roots.length > 0) {
      const uniqueRoots: string[] = [];
      for (const root of roots) {
        const existingIndex = uniqueRoots.findIndex(
          (entry) => path.resolve(entry) === path.resolve(root),
        );
        if (existingIndex >= 0) {
          uniqueRoots.splice(existingIndex, 1);
        }
        uniqueRoots.push(root);
      }
      return uniqueRoots;
    }
  }
  const systemdStateDir = resolveSystemdStateDirectory(env);
  if (systemdStateDir) {
    return [path.join(systemdStateDir, "plugin-runtime-deps")];
  }
  return [path.join(resolveStateDir(env, os.homedir), "plugin-runtime-deps")];
}

export function pruneUnknownBundledRuntimeDepsRoots(
  params: {
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
    maxRootsToKeep?: number;
    minAgeMs?: number;
    warn?: (message: string) => void;
  } = {},
): { scanned: number; removed: number; skippedLocked: number } {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const maxRootsToKeep = Math.max(
    0,
    params.maxRootsToKeep ?? DEFAULT_UNKNOWN_RUNTIME_DEPS_ROOTS_TO_KEEP,
  );
  const minAgeMs = Math.max(0, params.minAgeMs ?? DEFAULT_UNKNOWN_RUNTIME_DEPS_MIN_AGE_MS);
  let scanned = 0;
  let removed = 0;
  let skippedLocked = 0;
  const removeRoot = (root: string): void => {
    const lockDir = path.join(root, BUNDLED_RUNTIME_DEPS_LOCK_DIR);
    if (fs.existsSync(lockDir) && !removeRuntimeDepsLockIfStale(lockDir, nowMs)) {
      skippedLocked += 1;
      return;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      params.warn?.(`failed to remove stale bundled runtime deps root ${root}: ${String(error)}`);
    }
  };

  for (const baseDir of resolveBundledRuntimeDepsExternalBaseDirs(env)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const unknownRoots = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openclaw-unknown-"))
      .map((entry) => {
        const root = path.join(baseDir, entry.name);
        try {
          return { root, mtimeMs: fs.statSync(root).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { root: string; mtimeMs: number } => entry !== null)
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
    const legacyVersionedRoots = entries
      .filter(
        (entry) => entry.isDirectory() && isLegacyVersionedBundledRuntimeDepsRootName(entry.name),
      )
      .map((entry) => path.join(baseDir, entry.name))
      .toSorted((left, right) => left.localeCompare(right));
    scanned += unknownRoots.length;
    scanned += legacyVersionedRoots.length;

    for (const [index, entry] of unknownRoots.entries()) {
      const ageMs = nowMs - entry.mtimeMs;
      if (index < maxRootsToKeep && ageMs < minAgeMs) {
        continue;
      }
      removeRoot(entry.root);
    }

    for (const root of legacyVersionedRoots) {
      removeRoot(root);
    }
  }

  return { scanned, removed, skippedLocked };
}

function isLegacyVersionedBundledRuntimeDepsRootName(name: string): boolean {
  return (
    name.startsWith("openclaw-") &&
    readPackageKeyPathHash(name) === null &&
    LEGACY_VERSIONED_RUNTIME_DEPS_ROOT_RE.test(name)
  );
}

export function listSiblingExternalBundledRuntimeDepsRoots(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = params.env ?? process.env;
  const installRoot = path.resolve(params.installRoot);
  const installRootHash = readPackageKeyPathHash(path.basename(installRoot));
  if (!installRootHash) {
    return [];
  }
  const candidateParents = resolveBundledRuntimeDepsExternalBaseDirs(env);
  const seenParents = new Set<string>();
  const candidates: { root: string; mtimeMs: number; name: string }[] = [];

  for (const parentDir of candidateParents) {
    const resolvedParent = path.resolve(parentDir);
    if (seenParents.has(resolvedParent)) {
      continue;
    }
    seenParents.add(resolvedParent);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith("openclaw-") ||
        readPackageKeyPathHash(entry.name) !== installRootHash
      ) {
        continue;
      }
      const root = path.join(parentDir, entry.name);
      if (path.resolve(root) === installRoot) {
        continue;
      }
      try {
        candidates.push({
          root,
          mtimeMs: fs.statSync(root).mtimeMs,
          name: entry.name,
        });
      } catch {
        // Ignore roots that disappear while we are scanning for reusable deps.
      }
    }
  }

  return candidates
    .toSorted((left, right) => {
      const timeOrder = right.mtimeMs - left.mtimeMs;
      return timeOrder === 0 ? left.name.localeCompare(right.name) : timeOrder;
    })
    .map((entry) => entry.root);
}

function readPackageKeyPathHash(packageKey: string): string | null {
  return PACKAGE_KEY_PATH_HASH_RE.exec(packageKey)?.[1] ?? null;
}

function resolveExternalBundledRuntimeDepsInstallRoots(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const packageRoot = resolveBundledPluginPackageRoot(params.pluginRoot) ?? params.pluginRoot;
  const existingExternalRoots = resolveExistingExternalBundledRuntimeDepsRoots({
    packageRoot,
    env: params.env,
  });
  if (existingExternalRoots) {
    return existingExternalRoots;
  }
  const version = sanitizePathSegment(readPackageVersion(packageRoot));
  const packageKey = `openclaw-${version}-${createPathHash(packageRoot)}`;
  return resolveBundledRuntimeDepsExternalBaseDirs(params.env).map((baseDir) =>
    path.join(baseDir, packageKey),
  );
}

function resolveExistingExternalBundledRuntimeDepsRoots(params: {
  packageRoot: string;
  env: NodeJS.ProcessEnv;
}): string[] | null {
  const packageRoot = realpathOrResolve(params.packageRoot);
  const externalBaseDirs = resolveBundledRuntimeDepsExternalBaseDirs(params.env);
  for (const externalBaseDir of externalBaseDirs) {
    const relative = path.relative(realpathOrResolve(externalBaseDir), packageRoot);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const packageKey = relative.split(path.sep)[0];
    if (!packageKey || !packageKey.startsWith("openclaw-")) {
      continue;
    }
    return externalBaseDirs.map((baseDir) => path.join(baseDir, packageKey));
  }
  return null;
}

function realpathOrResolve(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function createBundledRuntimeDepsInstallRootPlan(params: {
  installRoot: string;
  searchRoots: readonly string[];
  external: boolean;
}): BundledRuntimeDepsInstallRootPlan {
  const searchRoots: string[] = [];
  for (const root of params.searchRoots) {
    const resolved = path.resolve(root);
    if (!searchRoots.some((entry) => path.resolve(entry) === resolved)) {
      searchRoots.push(root);
    }
  }
  if (!searchRoots.some((entry) => path.resolve(entry) === path.resolve(params.installRoot))) {
    searchRoots.push(params.installRoot);
  }
  return {
    installRoot: params.installRoot,
    searchRoots,
    external: params.external,
  };
}

export function resolveBundledRuntimeDependencyPackageInstallRootPlan(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRootPlan {
  const env = options.env ?? process.env;
  const externalRoots = resolveExternalBundledRuntimeDepsInstallRoots({
    pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
    env,
  });
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim() ||
    !isSourceCheckoutRoot(packageRoot)
  ) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: externalRoots.at(-1)!,
      searchRoots: externalRoots,
      external: true,
    });
  }
  if (isWritableDirectory(packageRoot)) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: packageRoot,
      searchRoots: [packageRoot],
      external: false,
    });
  }
  return createBundledRuntimeDepsInstallRootPlan({
    installRoot: externalRoots.at(-1)!,
    searchRoots: externalRoots,
    external: true,
  });
}

export function resolveBundledRuntimeDependencyPackageInstallRoot(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  return resolveBundledRuntimeDependencyPackageInstallRootPlan(packageRoot, options).installRoot;
}

export function resolveBundledRuntimeDependencyInstallRootPlan(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRootPlan {
  const env = options.env ?? process.env;
  const externalRoots = resolveExternalBundledRuntimeDepsInstallRoots({ pluginRoot, env });
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim() ||
    isPackagedBundledPluginRoot(pluginRoot)
  ) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: externalRoots.at(-1)!,
      searchRoots: externalRoots,
      external: true,
    });
  }
  if (isWritableDirectory(pluginRoot)) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: pluginRoot,
      searchRoots: [pluginRoot],
      external: false,
    });
  }
  return createBundledRuntimeDepsInstallRootPlan({
    installRoot: externalRoots.at(-1)!,
    searchRoots: externalRoots,
    external: true,
  });
}

export function resolveBundledRuntimeDependencyInstallRoot(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  return resolveBundledRuntimeDependencyInstallRootPlan(pluginRoot, options).installRoot;
}
