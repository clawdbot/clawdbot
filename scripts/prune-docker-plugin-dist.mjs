// Prunes omitted bundled plugin files and their unshared runtime dependencies
// from Docker-oriented production package output, then links the retained
// externally distributed plugins' own dependencies under their packaged roots.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRootPackageExcludedExtensionDirs } from "./lib/bundled-plugin-build-entries.mjs";
import { linkSourcePluginDependencies } from "./lib/bundled-plugin-dependency-links.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
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

/**
 * Parses OPENCLAW_EXTENSIONS into the bundled plugin ids that Docker should keep.
 */
export function parseDockerPluginKeepList(value) {
  return parsePluginList(value);
}

function readPackageJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectRuntimeDependencyNames(packageJson, options = {}) {
  const dependencies = new Set();
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const dependencyName of Object.keys(packageJson?.[field] ?? {})) {
      dependencies.add(dependencyName);
    }
  }
  for (const dependencyName of Object.keys(packageJson?.peerDependencies ?? {})) {
    const optional = packageJson?.peerDependenciesMeta?.[dependencyName]?.optional === true;
    if (options.includeOptionalPeers === true || !optional) {
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

function nodeModulePath(repoRoot, packageName) {
  return path.join(repoRoot, "node_modules", ...packageName.split("/"));
}

// Follow Node's importer-relative lookup: hoisted installs can contain several versions,
// and root-only traversal can misclassify a kept dependency as exclusive to an omitted plugin.
function resolveNodeModulePackageDir(importerDir, packageName) {
  let currentDir = fs.realpathSync(importerDir);

  while (true) {
    const packageDir = path.join(currentDir, "node_modules", ...packageName.split("/"));
    if (fs.existsSync(path.join(packageDir, "package.json"))) {
      return fs.realpathSync(packageDir);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
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

function collectPackageRuntimeClosure(repoRoot, seeds, options = {}) {
  const packageDirs = new Set();
  const rootPackageNames = new Set();
  const stack = [...seeds];

  while (stack.length > 0) {
    const entry = stack.pop();
    const packageDir = resolveNodeModulePackageDir(entry.importerDir, entry.packageName);
    if (!packageDir) {
      continue;
    }

    const rootPackageDir = nodeModulePath(repoRoot, entry.packageName);
    if (
      fs.existsSync(path.join(rootPackageDir, "package.json")) &&
      fs.realpathSync(rootPackageDir) === packageDir
    ) {
      rootPackageNames.add(entry.packageName);
    }
    if (packageDirs.has(packageDir)) {
      continue;
    }
    packageDirs.add(packageDir);

    const packageJson = readPackageJson(path.join(packageDir, "package.json"));
    for (const dependencyName of collectRuntimeDependencyNames(packageJson, options)) {
      stack.push({ importerDir: packageDir, packageName: dependencyName });
    }
  }

  return { packageDirs, rootPackageNames };
}

function collectWorkspacePackageRuntimeSeeds(repoRoot, workspaceDir, excludedPluginIds) {
  const seeds = [];
  const workspaceRoot = path.join(repoRoot, workspaceDir);
  if (!fs.existsSync(workspaceRoot)) {
    return seeds;
  }

  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || excludedPluginIds.has(entry.name)) {
      continue;
    }
    const importerDir = path.join(workspaceRoot, entry.name);
    const packageJson = readPackageJson(path.join(importerDir, "package.json"));
    if (typeof packageJson?.name === "string") {
      seeds.push({ importerDir, packageName: packageJson.name });
    }
    for (const packageName of collectRuntimeDependencyNames(packageJson)) {
      seeds.push({ importerDir, packageName });
    }
  }
  return seeds;
}

function pruneNodeModulesForOmittedPlugins(repoRoot, bundledPluginDir, omittedPluginIds) {
  const rootPackageJson = readPackageJson(path.join(repoRoot, "package.json"));
  const omittedPackageNames = new Set();
  const omittedSeeds = [];

  for (const pluginId of omittedPluginIds) {
    const importerDir = path.join(repoRoot, bundledPluginDir, pluginId);
    const packageJson = readPackageJson(path.join(importerDir, "package.json"));
    if (typeof packageJson?.name === "string") {
      omittedPackageNames.add(packageJson.name);
    }
    for (const packageName of collectRuntimeDependencyNames(packageJson)) {
      omittedSeeds.push({ importerDir, packageName });
    }
  }

  const keptSeeds = [...collectRuntimeDependencyNames(rootPackageJson)].map((packageName) => ({
    importerDir: repoRoot,
    packageName,
  }));
  keptSeeds.push(...collectWorkspacePackageRuntimeSeeds(repoRoot, "packages", new Set()));
  keptSeeds.push(
    ...collectWorkspacePackageRuntimeSeeds(repoRoot, bundledPluginDir, omittedPluginIds),
  );

  const keptClosure = collectPackageRuntimeClosure(repoRoot, keptSeeds);
  // Hoisted workspace dev dependencies can satisfy optional peers of omitted
  // plugins. Treat those installed peer-only branches as removal candidates;
  // the kept runtime closure below remains authoritative.
  const omittedClosure = collectPackageRuntimeClosure(repoRoot, omittedSeeds, {
    includeOptionalPeers: true,
  });
  const removed = [];
  const removalCandidates = new Set([...omittedPackageNames, ...omittedClosure.rootPackageNames]);

  for (const packageName of [...removalCandidates].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const packageDir = nodeModulePath(repoRoot, packageName);
    if (!fs.existsSync(packageDir)) {
      continue;
    }
    if (keptClosure.packageDirs.has(fs.realpathSync(packageDir))) {
      continue;
    }
    removePathIfExists(packageDir);
    removeEmptyScopeDir(repoRoot, packageName);
    removed.push(path.relative(repoRoot, packageDir).replaceAll("\\", "/"));
  }

  return removed;
}

// Docker compiles selected externally distributed plugins into the unified dist
// graph, but their dependencies stay plugin-local under the isolated pnpm install
// instead of the root node_modules that dist/extensions/<id> can reach. Link them
// under the packaged root, as isolated source checkouts do, and fail closed when a
// declared dependency still does not resolve from there: the plugin would otherwise
// ship loadable-looking but be rejected by dependency diagnostics at runtime.
function linkRetainedPluginDependencies(repoRoot, bundledPluginDir, retainedPluginIds) {
  const unreachable = [];
  for (const pluginId of [...retainedPluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const distPluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
    if (!fs.existsSync(distPluginDir)) {
      continue;
    }
    const pluginDir = path.join(repoRoot, bundledPluginDir, pluginId);
    const distNodeModules = path.join(distPluginDir, "node_modules");
    fs.rmSync(distNodeModules, { recursive: true, force: true });
    linkSourcePluginDependencies(pluginDir, distNodeModules);
    const packageJson = readPackageJson(path.join(pluginDir, "package.json"));
    for (const packageName of Object.keys(packageJson?.dependencies ?? {})) {
      if (
        !(packageName in (packageJson.optionalDependencies ?? {})) &&
        !resolveNodeModulePackageDir(distPluginDir, packageName)
      ) {
        unreachable.push(`${pluginId}: ${packageName}`);
      }
    }
  }
  if (unreachable.length > 0) {
    throw new Error(
      `plugin dependencies are not reachable from their packaged dist roots:\n${unreachable.join("\n")}`,
    );
  }
}

/**
 * Removes omitted plugin dist trees plus node_modules packages not needed by kept runtime code,
 * then links retained externally distributed plugin dependencies under their packaged roots.
 */
export function pruneDockerPluginDist(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const bundledPluginDir = env.OPENCLAW_BUNDLED_PLUGIN_DIR ?? "extensions";
  const keepPluginIds = parseDockerPluginKeepList(env.OPENCLAW_EXTENSIONS);
  const excludedPluginIds = collectRootPackageExcludedExtensionDirs({ cwd: repoRoot });
  const omittedPluginIds = new Set(
    [...excludedPluginIds].filter((pluginId) => !keepPluginIds.has(pluginId)),
  );
  const removed = [];

  // The removals below recurse into dist/ and dist-runtime/ plugin trees;
  // refuse to follow a symlinked output root into its target.
  assertRealOutputRoot(path.join(repoRoot, "dist"));
  assertRealOutputRoot(path.join(repoRoot, "dist-runtime"));

  removed.push(...pruneNodeModulesForOmittedPlugins(repoRoot, bundledPluginDir, omittedPluginIds));

  for (const pluginId of [...omittedPluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
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

  linkRetainedPluginDependencies(
    repoRoot,
    bundledPluginDir,
    [...excludedPluginIds].filter((pluginId) => keepPluginIds.has(pluginId)),
  );

  return removed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  pruneDockerPluginDist();
}
