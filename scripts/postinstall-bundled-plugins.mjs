#!/usr/bin/env node
// Package lifecycle cleanup and completion touch only this installed package.
// Operator state migration and legacy dependency cleanup belong to Doctor:
// another installed Gateway may still depend on the old state and files.
import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "./lib/package-lifecycle-marker.mjs";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = join(scriptDir, "..");
const DISABLE_POSTINSTALL_ENV = "OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL";
const DIST_INVENTORY_PATH = "dist/postinstall-inventory.json";
// One budget covers all three prune walks (legacy-deps prepass, file listing,
// empty-dir sweep). npm upgrades transiently hold old+new content-hashed dist
// files, so a real upgrade scan totals ~24k entries today (2026.6.x); keep ~4x
// headroom so dist growth cannot fail `npm install -g` while still refusing
// pathological/unbounded trees.
export const MAX_INSTALLED_DIST_SCAN_ENTRIES = 100_000;
class InstalledDistScanLimitError extends Error {}

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function readInstalledDistInventory(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const readFile = params.readFileSync ?? readFileSync;
  const inventoryPath = join(packageRoot, DIST_INVENTORY_PATH);
  if (!pathExists(inventoryPath)) {
    throw new Error(`missing dist inventory: ${DIST_INVENTORY_PATH}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFile(inventoryPath, "utf8"));
  } catch {
    throw new Error(`invalid dist inventory: ${DIST_INVENTORY_PATH}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`invalid dist inventory: ${DIST_INVENTORY_PATH}`);
  }
  return new Set(parsed.map(normalizeRelativePath));
}

function isRecoverableInstalledDistInventoryError(error) {
  return error instanceof Error && /^(missing|invalid) dist inventory: /u.test(error.message);
}

function resolveInstalledDistRoot(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const pathLstat = params.lstatSync ?? lstatSync;
  const resolveRealPath = params.realpathSync ?? realpathSync;
  const distDir = join(packageRoot, "dist");
  if (!pathExists(distDir)) {
    return null;
  }
  const distStats = pathLstat(distDir);
  if (!distStats.isDirectory() || distStats.isSymbolicLink()) {
    throw new Error("unsafe dist root: dist must be a real directory");
  }
  const packageRootReal = resolveRealPath(packageRoot);
  const distDirReal = resolveRealPath(distDir);
  const relativeDistPath = relative(packageRootReal, distDirReal);
  if (relativeDistPath !== "dist") {
    throw new Error("unsafe dist root: dist escaped package root");
  }
  return { distDir, distDirReal, packageRootReal };
}

function assertSafeInstalledDistPath(relativePath, params) {
  const resolveRealPath = params.realpathSync ?? realpathSync;
  const candidatePath = join(params.packageRoot, relativePath);
  const candidateRealPath = resolveRealPath(candidatePath);
  const relativeCandidatePath = relative(params.distDirReal, candidateRealPath);
  if (relativeCandidatePath.startsWith("..") || isAbsolute(relativeCandidatePath)) {
    throw new Error(`unsafe dist path: ${relativePath}`);
  }
  return candidatePath;
}

function createInstalledDistScanBudget(params = {}) {
  return {
    entries: 0,
    limit: params.maxDistScanEntries ?? MAX_INSTALLED_DIST_SCAN_ENTRIES,
  };
}

function resolveInstalledDistScanBudget(params = {}) {
  return params.distScanBudget ?? createInstalledDistScanBudget(params);
}

function countInstalledDistScanEntry(budget) {
  budget.entries += 1;
  if (budget.entries > budget.limit) {
    throw new InstalledDistScanLimitError(
      `installed dist scan exceeded ${budget.limit} filesystem entries; refusing to scan unbounded package contents`,
    );
  }
}

function* iterateInstalledDistEntries(currentDir, params = {}) {
  if (params.readdirSync) {
    yield* params.readdirSync(currentDir, { withFileTypes: true });
    return;
  }

  const dir = opendirSync(currentDir);
  try {
    while (true) {
      const entry = dir.readSync();
      if (!entry) {
        break;
      }
      yield entry;
    }
  } finally {
    dir.closeSync();
  }
}

function* iterateOptionalInstalledDistEntries(currentDir, params = {}) {
  try {
    yield* iterateInstalledDistEntries(currentDir, params);
  } catch (error) {
    if (error instanceof InstalledDistScanLimitError) {
      throw error;
    }
  }
}

function listInstalledDistFiles(params = {}) {
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return [];
  }
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pending = [distRoot.distDir];
  const files = [];
  const budget = resolveInstalledDistScanBudget(params);
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }
    for (const entry of iterateInstalledDistEntries(currentDir, params)) {
      countInstalledDistScanEntry(budget);
      const entryPath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `unsafe dist entry: ${normalizeRelativePath(relative(packageRoot, entryPath))}`,
        );
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = normalizeRelativePath(relative(packageRoot, entryPath));
      if (relativePath === DIST_INVENTORY_PATH) {
        continue;
      }
      files.push(relativePath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function pruneEmptyDistDirectories(params = {}) {
  const removeDirectory = params.rmdirSync ?? rmdirSync;
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return;
  }
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathLstat = params.lstatSync ?? lstatSync;
  const budget = resolveInstalledDistScanBudget(params);

  function isDirectoryEmpty(currentDir) {
    for (const entry of iterateInstalledDistEntries(currentDir, params)) {
      void entry;
      countInstalledDistScanEntry(budget);
      return false;
    }
    return true;
  }

  function prune(currentDir) {
    const childDirs = [];
    for (const entry of iterateInstalledDistEntries(currentDir, params)) {
      countInstalledDistScanEntry(budget);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `unsafe dist entry: ${normalizeRelativePath(relative(packageRoot, join(currentDir, entry.name)))}`,
        );
      }
      if (!entry.isDirectory()) {
        continue;
      }
      childDirs.push(join(currentDir, entry.name));
    }
    for (const childDir of childDirs) {
      prune(childDir);
    }
    if (currentDir === distRoot.distDir) {
      return;
    }
    const currentStats = pathLstat(currentDir);
    if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
      throw new Error(
        `unsafe dist directory: ${normalizeRelativePath(relative(packageRoot, currentDir))}`,
      );
    }
    if (isDirectoryEmpty(currentDir)) {
      removeDirectory(
        assertSafeInstalledDistPath(normalizeRelativePath(relative(packageRoot, currentDir)), {
          packageRoot,
          distDirReal: distRoot.distDirReal,
          realpathSync: params.realpathSync,
        }),
      );
    }
  }

  prune(distRoot.distDir);
}

function isLegacyInstalledPluginDependencyDirName(name) {
  return name === "node_modules" || /^\.openclaw-install-stage(?:-[^/]+)?$/iu.test(name);
}

function pruneLegacyInstalledPluginDependencyDirs(params) {
  const removePath = params.rmSync ?? rmSync;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const extensionsDir = join(packageRoot, "dist", "extensions");
  const budget = resolveInstalledDistScanBudget(params);
  const removed = [];

  for (const pluginEntry of iterateOptionalInstalledDistEntries(extensionsDir, params)) {
    countInstalledDistScanEntry(budget);
    if (!pluginEntry.isDirectory() || pluginEntry.isSymbolicLink()) {
      continue;
    }
    const pluginDir = join(extensionsDir, pluginEntry.name);
    const dependencyDirNames = [];
    for (const childEntry of iterateOptionalInstalledDistEntries(pluginDir, params)) {
      countInstalledDistScanEntry(budget);
      if (!isLegacyInstalledPluginDependencyDirName(childEntry.name)) {
        continue;
      }
      dependencyDirNames.push(childEntry.name);
    }
    if (dependencyDirNames.length === 0) {
      continue;
    }
    const safePluginDir = assertSafeInstalledDistPath(
      normalizeRelativePath(relative(packageRoot, pluginDir)),
      {
        packageRoot,
        distDirReal: params.distDirReal,
        realpathSync: params.realpathSync,
      },
    );
    for (const dependencyDirName of dependencyDirNames) {
      const relativePath = normalizeRelativePath(
        relative(packageRoot, join(pluginDir, dependencyDirName)),
      );
      removePath(join(safePluginDir, dependencyDirName), { recursive: true, force: true });
      removed.push(relativePath);
    }
  }

  return removed;
}

export function pruneInstalledPackageDist(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const removeFile = params.unlinkSync ?? unlinkSync;
  const log = params.log ?? console;
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return [];
  }
  const distScanBudget = createInstalledDistScanBudget(params);
  const distScanParams = { ...params, distScanBudget };
  const removedLegacyDependencyDirs = pruneLegacyInstalledPluginDependencyDirs({
    ...distScanParams,
    packageRoot,
    distDirReal: distRoot.distDirReal,
    realpathSync: params.realpathSync,
    rmSync: params.rmSync,
  });
  let expectedFiles = params.expectedFiles ?? null;
  if (expectedFiles === null) {
    try {
      expectedFiles = readInstalledDistInventory(params);
    } catch (error) {
      if (!isRecoverableInstalledDistInventoryError(error)) {
        throw error;
      }
      log.warn?.(`[postinstall] skipping dist prune: ${error.message}`);
      return [];
    }
  }
  const installedFiles = listInstalledDistFiles(distScanParams);
  const removed = [];

  for (const relativePath of installedFiles) {
    if (expectedFiles.has(relativePath)) {
      continue;
    }
    removeFile(
      assertSafeInstalledDistPath(relativePath, {
        packageRoot,
        distDirReal: distRoot.distDirReal,
        realpathSync: params.realpathSync,
      }),
    );
    removed.push(relativePath);
  }

  pruneEmptyDistDirectories(distScanParams);

  if (removed.length > 0) {
    log.log(`[postinstall] pruned stale dist files: ${removed.join(", ")}`);
  }
  if (removedLegacyDependencyDirs.length > 0) {
    log.log(
      `[postinstall] pruned legacy plugin dependency dirs: ${removedLegacyDependencyDirs.join(", ")}`,
    );
  }
  return removed;
}

export function isSourceCheckoutRoot(params) {
  const pathExists = params.existsSync ?? existsSync;
  const hasPostinstallInventory = pathExists(join(params.packageRoot, DIST_INVENTORY_PATH));
  return (
    (pathExists(join(params.packageRoot, ".git")) ||
      (pathExists(join(params.packageRoot, "pnpm-workspace.yaml")) && !hasPostinstallInventory)) &&
    pathExists(join(params.packageRoot, "src")) &&
    pathExists(join(params.packageRoot, "extensions"))
  );
}

export function runBundledPluginPostinstall(params = {}) {
  const env = params.env ?? process.env;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;
  if (env?.[DISABLE_POSTINSTALL_ENV]?.trim()) {
    return;
  }
  if (isSourceCheckoutRoot({ packageRoot, existsSync: pathExists })) {
    // pnpm owns source dependency versions and workspace links. Packaged cleanup
    // must not alter that install or the operator state from a development checkout.
    return;
  }
  pruneInstalledPackageDist({
    packageRoot,
    existsSync: pathExists,
    readFileSync: params.readFileSync,
    readdirSync: params.readdirSync,
    rmSync: params.rmSync,
    log,
  });
}

export function isDirectPostinstallInvocation(params = {}) {
  const entryPath = params.entryPath ?? process.argv[1];
  if (!entryPath) {
    return false;
  }
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const resolveRealPath = params.realpathSync ?? realpathSync;
  try {
    return resolveRealPath(entryPath) === resolveRealPath(modulePath);
  } catch {
    return pathToFileURL(entryPath).href === pathToFileURL(modulePath).href;
  }
}

export function completePackageLifecycle(params = {}, reportError = console.error) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const removePath = params.rmSync ?? rmSync;
  const markerPath = join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  try {
    removePath(markerPath, { force: true });
    return true;
  } catch (error) {
    reportError(`[postinstall] could not complete package lifecycle: ${String(error)}`);
    return false;
  }
}

if (isDirectPostinstallInvocation()) {
  runBundledPluginPostinstall();
  if (!completePackageLifecycle()) {
    process.exitCode = 1;
  }
}
