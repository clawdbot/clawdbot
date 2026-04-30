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

export type BundledRuntimeDepsInstallRoot = {
  installRoot: string;
  external: boolean;
};

export type BundledRuntimeDepsInstallRootPlan = BundledRuntimeDepsInstallRoot & {
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
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 12);
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
    scanned += unknownRoots.length;

    for (const [index, entry] of unknownRoots.entries()) {
      const ageMs = nowMs - entry.mtimeMs;
      if (index < maxRootsToKeep && ageMs < minAgeMs) {
        continue;
      }
      const lockDir = path.join(entry.root, BUNDLED_RUNTIME_DEPS_LOCK_DIR);
      if (fs.existsSync(lockDir) && !removeRuntimeDepsLockIfStale(lockDir, nowMs)) {
        skippedLocked += 1;
        continue;
      }
      try {
        fs.rmSync(entry.root, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        params.warn?.(
          `failed to remove stale bundled runtime deps root ${entry.root}: ${String(error)}`,
        );
      }
    }
  }

  return { scanned, removed, skippedLocked };
}

function resolveExternalBundledRuntimeDepsInstallRoot(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string {
  return resolveExternalBundledRuntimeDepsInstallRoots(params).at(-1)!;
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
      installRoot:
        externalRoots.at(-1) ??
        resolveExternalBundledRuntimeDepsInstallRoot({
          pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
          env,
        }),
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
    installRoot:
      externalRoots.at(-1) ??
      resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
        env,
      }),
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
      installRoot:
        externalRoots.at(-1) ??
        resolveExternalBundledRuntimeDepsInstallRoot({
          pluginRoot,
          env,
        }),
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
    installRoot:
      externalRoots.at(-1) ??
      resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot,
        env,
      }),
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

export function resolveBundledRuntimeDependencyInstallRootInfo(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRoot {
  const { installRoot, external } = resolveBundledRuntimeDependencyInstallRootPlan(
    pluginRoot,
    options,
  );
  return {
    installRoot,
    external,
  };
}
