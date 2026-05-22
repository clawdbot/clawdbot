import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRootPackageExcludedExtensionDirs } from "./lib/bundled-plugin-build-entries.mjs";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];

function parsePluginList(value) {
  if (typeof value !== "string") {
    return new Set();
  }
  return new Set(
    value
      .split(/[\s,]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function parseDockerPluginKeepList(value) {
  return parsePluginList(value);
}

function readPackageJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectRuntimeDependencyNames(packageJson) {
  const dependencies = new Set();
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const dependencyName of Object.keys(packageJson?.[field] ?? {})) {
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

function nodeModulePath(repoRoot, packageName) {
  return path.join(repoRoot, "node_modules", ...packageName.split("/"));
}

function removeEmptyScopeDir(repoRoot, packageName) {
  if (!packageName.startsWith("@")) {
    return;
  }
  const [scope] = packageName.split("/");
  const scopeDir = path.join(repoRoot, "node_modules", scope);
  try {
    fs.rmdirSync(scopeDir);
  } catch {
    // Scope still has other packages or does not exist.
  }
}

function collectPackageRuntimeClosure(repoRoot, seedPackageNames) {
  const seen = new Set();
  const stack = [...seedPackageNames];

  while (stack.length > 0) {
    const packageName = stack.pop();
    if (!packageName || seen.has(packageName)) {
      continue;
    }
    seen.add(packageName);

    const packageJson = readPackageJson(path.join(nodeModulePath(repoRoot, packageName), "package.json"));
    for (const dependencyName of collectRuntimeDependencyNames(packageJson)) {
      if (!seen.has(dependencyName)) {
        stack.push(dependencyName);
      }
    }
  }

  return seen;
}

function collectWorkspacePackageRuntimeSeeds(repoRoot, workspaceDir, excludedPluginIds) {
  const seeds = new Set();
  const workspaceRoot = path.join(repoRoot, workspaceDir);
  if (!fs.existsSync(workspaceRoot)) {
    return seeds;
  }

  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || excludedPluginIds.has(entry.name)) {
      continue;
    }
    const packageJson = readPackageJson(path.join(workspaceRoot, entry.name, "package.json"));
    if (typeof packageJson?.name === "string") {
      seeds.add(packageJson.name);
    }
    for (const dependencyName of collectRuntimeDependencyNames(packageJson)) {
      seeds.add(dependencyName);
    }
  }
  return seeds;
}

function pruneNodeModulesForOmittedPlugins(repoRoot, bundledPluginDir, omittedPluginIds) {
  const rootPackageJson = readPackageJson(path.join(repoRoot, "package.json"));
  const omittedPackageNames = new Set();
  const omittedSeeds = new Set();

  for (const pluginId of omittedPluginIds) {
    const packageJson = readPackageJson(path.join(repoRoot, bundledPluginDir, pluginId, "package.json"));
    if (typeof packageJson?.name === "string") {
      omittedPackageNames.add(packageJson.name);
    }
    for (const dependencyName of collectRuntimeDependencyNames(packageJson)) {
      omittedSeeds.add(dependencyName);
    }
  }

  const keptSeeds = new Set(collectRuntimeDependencyNames(rootPackageJson));
  for (const dependencyName of collectWorkspacePackageRuntimeSeeds(repoRoot, "packages", new Set())) {
    keptSeeds.add(dependencyName);
  }
  for (const dependencyName of collectWorkspacePackageRuntimeSeeds(
    repoRoot,
    bundledPluginDir,
    omittedPluginIds,
  )) {
    keptSeeds.add(dependencyName);
  }

  const keptClosure = collectPackageRuntimeClosure(repoRoot, keptSeeds);
  const omittedClosure = collectPackageRuntimeClosure(repoRoot, omittedSeeds);
  const removed = [];
  const removalCandidates = new Set([...omittedPackageNames, ...omittedClosure]);

  for (const packageName of [...removalCandidates].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (keptClosure.has(packageName)) {
      continue;
    }
    const packageDir = nodeModulePath(repoRoot, packageName);
    if (!fs.existsSync(packageDir)) {
      continue;
    }
    removePathIfExists(packageDir);
    removeEmptyScopeDir(repoRoot, packageName);
    removed.push(path.relative(repoRoot, packageDir).replaceAll("\\", "/"));
  }

  return removed;
}

export function pruneDockerPluginDist(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const bundledPluginDir = env.OPENCLAW_BUNDLED_PLUGIN_DIR ?? "extensions";
  const keepPluginIds = parseDockerPluginKeepList(env.OPENCLAW_EXTENSIONS);
  const excludedPluginIds = collectRootPackageExcludedExtensionDirs({ cwd: repoRoot });
  const omittedPluginIds = new Set([...excludedPluginIds].filter((pluginId) => !keepPluginIds.has(pluginId)));
  const removed = [];

  removed.push(...pruneNodeModulesForOmittedPlugins(repoRoot, bundledPluginDir, omittedPluginIds));

  for (const pluginId of [...omittedPluginIds].toSorted((left, right) => left.localeCompare(right))) {
    for (const pluginPath of [
      path.join(bundledPluginDir, pluginId),
      path.join("dist", "extensions", pluginId),
      path.join("dist-runtime", "extensions", pluginId),
    ]) {
      const absolutePluginPath = path.join(repoRoot, pluginPath);
      if (!fs.existsSync(absolutePluginPath)) {
        continue;
      }
      removePathIfExists(absolutePluginPath);
      removed.push(path.relative(repoRoot, absolutePluginPath).replaceAll("\\", "/"));
    }
  }

  return removed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  pruneDockerPluginDist();
}
