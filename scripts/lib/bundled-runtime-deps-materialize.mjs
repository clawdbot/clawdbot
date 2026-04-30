import fs from "node:fs";
import path from "node:path";
import {
  collectInstalledRuntimeDependencyRoots,
  dependencyNodeModulesPath,
  findContainingRealRoot,
  resolveInstalledDirectDependencyNames,
  selectRuntimeDependencyRootsToCopy,
} from "./bundled-runtime-deps-package-tree.mjs";
import { pruneStagedRuntimeDependencyCargo } from "./bundled-runtime-deps-prune.mjs";
import {
  assertPathIsNotSymlink,
  makePluginOwnedTempDir,
  removeOwnedTempPathBestEffort,
  removePathIfExists,
  replaceDirAtomically,
  writeJsonAtomically,
} from "./bundled-runtime-deps-stage-state.mjs";

function copyMaterializedDependencyTree(params) {
  const { activeRoots, allowedRealRoots, sourcePath, targetPath } = params;
  const sourceStats = fs.lstatSync(sourcePath);

  if (sourceStats.isSymbolicLink()) {
    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(sourcePath);
    } catch {
      return false;
    }
    const containingRoot = findContainingRealRoot(resolvedPath, allowedRealRoots);
    if (containingRoot === null) {
      return false;
    }
    if (activeRoots.has(containingRoot)) {
      return true;
    }
    const nextActiveRoots = new Set(activeRoots);
    nextActiveRoots.add(containingRoot);
    return copyMaterializedDependencyTree({
      activeRoots: nextActiveRoots,
      allowedRealRoots,
      sourcePath: resolvedPath,
      targetPath,
    });
  }

  if (sourceStats.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs
      .readdirSync(sourcePath, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (
        !copyMaterializedDependencyTree({
          activeRoots,
          allowedRealRoots,
          sourcePath: path.join(sourcePath, entry.name),
          targetPath: path.join(targetPath, entry.name),
        })
      ) {
        return false;
      }
    }
    return true;
  }

  if (sourceStats.isFile()) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, sourceStats.mode);
    return true;
  }

  return true;
}

export function listBundledPluginRuntimeDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(extensionsRoot, dirent.name))
    .filter((pluginDir) => fs.existsSync(path.join(pluginDir, "package.json")));
}

export function resolveInstalledWorkspacePluginRoot(repoRoot, pluginId) {
  const currentPluginRoot = path.join(repoRoot, "extensions", pluginId);
  if (fs.existsSync(path.join(currentPluginRoot, "node_modules"))) {
    return currentPluginRoot;
  }

  const nodeModulesDir = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    return currentPluginRoot;
  }

  let installedWorkspaceRoot;
  try {
    installedWorkspaceRoot = path.dirname(fs.realpathSync(nodeModulesDir));
  } catch {
    return currentPluginRoot;
  }

  const installedPluginRoot = path.join(installedWorkspaceRoot, "extensions", pluginId);
  if (fs.existsSync(path.join(installedPluginRoot, "package.json"))) {
    return installedPluginRoot;
  }

  return currentPluginRoot;
}

export function stageInstalledRootRuntimeDeps(params) {
  const {
    directDependencyPackageRoot = null,
    cheapFingerprint,
    fingerprint,
    packageJson,
    pluginDir,
    pruneConfig,
    repoRoot,
    stampPath,
  } = params;
  const dependencySpecs = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const optionalDependencyNames = new Set(Object.keys(packageJson.optionalDependencies ?? {}));
  const rootNodeModulesDir = path.join(repoRoot, "node_modules");
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(rootNodeModulesDir)) {
    return false;
  }

  const directDependencyNames = resolveInstalledDirectDependencyNames(
    rootNodeModulesDir,
    dependencySpecs,
    directDependencyPackageRoot,
    optionalDependencyNames,
  );
  if (directDependencyNames === null) {
    return false;
  }
  const resolution = collectInstalledRuntimeDependencyRoots(
    rootNodeModulesDir,
    dependencySpecs,
    directDependencyPackageRoot,
    optionalDependencyNames,
  );
  if (resolution === null) {
    return false;
  }
  const rootsToCopy = selectRuntimeDependencyRootsToCopy(resolution);
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  if (rootsToCopy.length === 0) {
    assertPathIsNotSymlink(nodeModulesDir, "remove runtime deps");
    removePathIfExists(nodeModulesDir);
    writeJsonAtomically(stampPath, {
      cheapFingerprint,
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  }
  const allowedRealRoots = rootsToCopy.map((record) => record.realRoot);

  const stagedNodeModulesDir = path.join(
    makePluginOwnedTempDir(pluginDir, "stage"),
    "node_modules",
  );

  try {
    for (const record of rootsToCopy.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const sourcePath = record.realRoot;
      const targetPath = dependencyNodeModulesPath(stagedNodeModulesDir, record.name);
      if (targetPath === null) {
        return false;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const sourceRootReal = findContainingRealRoot(sourcePath, allowedRealRoots);
      if (
        sourceRootReal === null ||
        !copyMaterializedDependencyTree({
          activeRoots: new Set([sourceRootReal]),
          allowedRealRoots,
          sourcePath,
          targetPath,
        })
      ) {
        return false;
      }
    }
    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir, pruneConfig);

    replaceDirAtomically(nodeModulesDir, stagedNodeModulesDir);
    writeJsonAtomically(stampPath, {
      cheapFingerprint,
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    removeOwnedTempPathBestEffort(path.dirname(stagedNodeModulesDir));
  }
}
