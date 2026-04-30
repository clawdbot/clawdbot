import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  createBundledRuntimeDependencyInstallArgs,
  createBundledRuntimeDependencyInstallEnv,
  runBundledRuntimeDependencyNpmInstall,
} from "./lib/bundled-runtime-deps-install.mjs";
import {
  listBundledPluginRuntimeDirs,
  resolveInstalledWorkspacePluginRoot,
  stageInstalledRootRuntimeDeps,
} from "./lib/bundled-runtime-deps-materialize.mjs";
import {
  readInstalledDependencyVersionFromRoot,
  resolveInstalledDependencyRoot,
  resolveInstalledRuntimeClosureFingerprint,
} from "./lib/bundled-runtime-deps-package-tree.mjs";
import {
  pruneStagedRuntimeDependencyCargo,
  resolveRuntimeDepPruneConfig,
} from "./lib/bundled-runtime-deps-prune.mjs";
import {
  assertPathIsNotSymlink,
  makePluginOwnedTempDir,
  removeOwnedTempPathBestEffort,
  removePathIfExists,
  removeStaleRuntimeDepsTempDirs,
  replaceDirAtomically,
  sanitizeTempPrefixSegment,
  writeJsonAtomically,
  writeRuntimeDepsTempOwner,
} from "./lib/bundled-runtime-deps-stage-state.mjs";
import {
  createRuntimeDepsCheapFingerprint,
  createRuntimeDepsFingerprint,
  readRuntimeDepsStamp,
  resolveLegacyRuntimeDepsStampPath,
  resolveRuntimeDepsStampPath,
} from "./lib/bundled-runtime-deps-stamp.mjs";
import { resolveNpmRunner } from "./npm-runner.mjs";

const exactVersionSpecRe = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasRuntimeDeps(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function shouldStageRuntimeDeps(packageJson) {
  return packageJson.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  if (packageJson.peerDependencies) {
    delete packageJson.peerDependencies;
    changed = true;
  }

  if (packageJson.peerDependenciesMeta) {
    delete packageJson.peerDependenciesMeta;
    changed = true;
  }

  if (packageJson.devDependencies) {
    delete packageJson.devDependencies;
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }

  return packageJson;
}

function isSafeRuntimeDependencySpec(spec) {
  if (typeof spec !== "string") {
    return false;
  }
  const normalized = spec.trim();
  if (normalized.length === 0) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (
    lower.startsWith("file:") ||
    lower.startsWith("link:") ||
    lower.startsWith("workspace:") ||
    lower.startsWith("git:") ||
    lower.startsWith("git+") ||
    lower.startsWith("ssh:") ||
    lower.startsWith("http:") ||
    lower.startsWith("https:")
  ) {
    return false;
  }
  if (normalized.includes("://")) {
    return false;
  }
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    normalized.startsWith("../") ||
    normalized.startsWith("..\\") ||
    normalized.includes("/../") ||
    normalized.includes("\\..\\")
  ) {
    return false;
  }
  return true;
}

function assertSafeRuntimeDependencySpec(depName, spec) {
  if (!isSafeRuntimeDependencySpec(spec)) {
    throw new Error(`disallowed runtime dependency spec for ${depName}: ${spec}`);
  }
}

function resolveInstalledPinnedDependencyVersion(params) {
  const depRoot = resolveInstalledDependencyRoot({
    depName: params.depName,
    enforceSpec: true,
    parentPackageRoot: params.parentPackageRoot,
    rootNodeModulesDir: params.rootNodeModulesDir,
    spec: params.spec,
  });
  if (depRoot === null) {
    return null;
  }
  return readInstalledDependencyVersionFromRoot(depRoot);
}

function resolvePinnedRuntimeDependencyVersion(params) {
  assertSafeRuntimeDependencySpec(params.depName, params.spec);
  if (exactVersionSpecRe.test(params.spec)) {
    return params.spec;
  }
  const installedVersion = resolveInstalledPinnedDependencyVersion(params);
  if (typeof installedVersion === "string" && exactVersionSpecRe.test(installedVersion)) {
    return installedVersion;
  }
  throw new Error(
    `runtime dependency ${params.depName} must resolve to an exact installed version, got: ${params.spec}`,
  );
}

function collectRuntimeDependencyGroups(packageJson) {
  const readRuntimeGroup = (group) =>
    Object.fromEntries(
      Object.entries(group ?? {}).filter(
        (entry) => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  return {
    dependencies: readRuntimeGroup(packageJson.dependencies),
    optionalDependencies: readRuntimeGroup(packageJson.optionalDependencies),
  };
}

function resolvePinnedRuntimeDependencyGroup(group, params = {}) {
  return Object.fromEntries(
    Object.entries(group).map(([name, version]) => {
      const pinnedVersion = resolvePinnedRuntimeDependencyVersion({
        depName: name,
        parentPackageRoot: params.directDependencyPackageRoot ?? null,
        rootNodeModulesDir: params.rootNodeModulesDir ?? path.join(process.cwd(), "node_modules"),
        spec: version,
      });
      return [name, pinnedVersion];
    }),
  );
}

function resolvePinnedRuntimeDependencyGroups(packageJson, params = {}) {
  const runtimeGroups = collectRuntimeDependencyGroups(packageJson);
  return {
    dependencies: resolvePinnedRuntimeDependencyGroup(runtimeGroups.dependencies, params),
    optionalDependencies: resolvePinnedRuntimeDependencyGroup(
      runtimeGroups.optionalDependencies,
      params,
    ),
  };
}

export function collectRuntimeDependencyInstallManifest(packageJson, params = {}) {
  const pinnedGroups = resolvePinnedRuntimeDependencyGroups(packageJson, params);
  return createRuntimeInstallManifest(params.pluginId ?? "runtime-deps", pinnedGroups);
}

export function collectRuntimeDependencyInstallSpecs(packageJson, params = {}) {
  const manifest = collectRuntimeDependencyInstallManifest(packageJson, params);
  const buildSpecs = (group) =>
    Object.entries(group ?? {}).map(([name, version]) => `${name}@${String(version)}`);
  return {
    dependencies: buildSpecs(manifest.dependencies),
    optionalDependencies: buildSpecs(manifest.optionalDependencies),
  };
}

function createRuntimeInstallManifest(pluginId, pinnedGroups) {
  const manifest = {
    name: `openclaw-runtime-deps-${sanitizeTempPrefixSegment(pluginId)}`,
    private: true,
    version: "0.0.0",
  };
  if (Object.keys(pinnedGroups.dependencies).length > 0) {
    manifest.dependencies = pinnedGroups.dependencies;
  }
  if (Object.keys(pinnedGroups.optionalDependencies).length > 0) {
    manifest.optionalDependencies = pinnedGroups.optionalDependencies;
  }
  return manifest;
}

function runNpmInstall(params) {
  return runBundledRuntimeDependencyNpmInstall({
    cwd: params.cwd,
    npmRunner: params.npmRunner,
    env: createBundledRuntimeDependencyInstallEnv(params.npmRunner.env ?? process.env, {
      ci: true,
      quiet: true,
    }),
    spawnSyncImpl: params.spawnSyncImpl,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: params.timeoutMs ?? 5 * 60 * 1000,
  });
}

function installPluginRuntimeDepsWithRetries(params) {
  const { attempts = 3 } = params;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      params.install({ ...params.installParams, attempt });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
    }
  }
  throw lastError;
}

function createRootRuntimeStagingError(params) {
  const runtimeDependencyNames = [
    ...Object.keys(params.packageJson.dependencies ?? {}),
    ...Object.keys(params.packageJson.optionalDependencies ?? {}),
  ].toSorted((left, right) => left.localeCompare(right));
  const dependencyLabel =
    runtimeDependencyNames.length > 0 ? runtimeDependencyNames.join(", ") : "<none>";
  const causeMessage =
    params.cause instanceof Error && typeof params.cause.message === "string"
      ? ` Cause: ${params.cause.message}`
      : "";
  return new Error(
    `failed to stage bundled runtime deps for ${params.pluginId}: ` +
      `runtime dependency closure must resolve from the installed root workspace graph. ` +
      `Could not materialize: ${dependencyLabel}. ` +
      "Run `pnpm install` and rebuild from a trusted workspace checkout, or provide a hardened fallback installer." +
      causeMessage,
  );
}

function installPluginRuntimeDeps(params) {
  const {
    directDependencyPackageRoot = null,
    cheapFingerprint,
    fingerprint,
    packageJson,
    pluginDir,
    pluginId,
    pruneConfig,
    repoRoot,
    stampPath,
  } = params;
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const tempInstallDir = makePluginOwnedTempDir(pluginDir, "install");
  const pinnedGroups = resolvePinnedRuntimeDependencyGroups(packageJson, {
    directDependencyPackageRoot,
    rootNodeModulesDir: path.join(repoRoot, "node_modules"),
  });
  const requiredDependencyCount = Object.keys(pinnedGroups.dependencies).length;
  try {
    writeJson(
      path.join(tempInstallDir, "package.json"),
      createRuntimeInstallManifest(pluginId, pinnedGroups),
    );
    if (requiredDependencyCount > 0 || Object.keys(pinnedGroups.optionalDependencies).length > 0) {
      runNpmInstall({
        cwd: tempInstallDir,
        npmRunner: resolveNpmRunner({
          npmArgs: createBundledRuntimeDependencyInstallArgs([], {
            noAudit: true,
            noFund: true,
            silent: true,
          }),
        }),
      });
    }
    const stagedNodeModulesDir = path.join(tempInstallDir, "node_modules");
    if (requiredDependencyCount > 0 && !fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: explicit npm install produced no node_modules directory`,
      );
    }
    if (fs.existsSync(stagedNodeModulesDir)) {
      pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir, pruneConfig);
      replaceDirAtomically(nodeModulesDir, stagedNodeModulesDir);
    } else {
      assertPathIsNotSymlink(nodeModulesDir, "remove runtime deps");
      removePathIfExists(nodeModulesDir);
    }
    writeJsonAtomically(stampPath, {
      cheapFingerprint,
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removeOwnedTempPathBestEffort(tempInstallDir);
  }
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const installPluginRuntimeDepsImpl =
    params.installPluginRuntimeDepsImpl ?? installPluginRuntimeDeps;
  const installAttempts = params.installAttempts ?? 3;
  const pruneConfig = resolveRuntimeDepPruneConfig(params);
  const timingsEnabled =
    params.timings ?? process.env.OPENCLAW_RUNTIME_DEPS_STAGING_TIMINGS === "1";
  const runPluginPhase = (pluginId, label, action) => {
    const startedAt = performance.now();
    try {
      return action();
    } finally {
      if (timingsEnabled) {
        const durationMs = Math.round(performance.now() - startedAt);
        console.error(
          `stage-bundled-plugin-runtime-deps: ${pluginId} ${label} completed in ${durationMs}ms`,
        );
      }
    }
  };
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const sourcePluginRoot = resolveInstalledWorkspacePluginRoot(repoRoot, pluginId);
    const directDependencyPackageRoot = fs.existsSync(path.join(sourcePluginRoot, "package.json"))
      ? sourcePluginRoot
      : null;
    const packageJson = runPluginPhase(pluginId, "sanitize manifest", () =>
      sanitizeBundledManifestForRuntimeInstall(pluginDir),
    );
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    const stampPath = resolveRuntimeDepsStampPath(repoRoot, pluginId);
    const legacyStampPath = resolveLegacyRuntimeDepsStampPath(pluginDir);
    runPluginPhase(pluginId, "cleanup stale runtime dirs", () => {
      removePathIfExists(legacyStampPath);
      removeStaleRuntimeDepsTempDirs(pluginDir);
    });
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      runPluginPhase(pluginId, "remove unstaged runtime deps", () => {
        removePathIfExists(nodeModulesDir);
        removePathIfExists(stampPath);
      });
      continue;
    }
    const cheapFingerprint = runPluginPhase(pluginId, "cheap fingerprint", () =>
      createRuntimeDepsCheapFingerprint(packageJson, pruneConfig, {
        repoRoot,
      }),
    );
    const stamp = readRuntimeDepsStamp(stampPath);
    const rootInstalledRuntimeFingerprint = runPluginPhase(
      pluginId,
      "installed runtime fingerprint",
      () =>
        resolveInstalledRuntimeClosureFingerprint({
          directDependencyPackageRoot,
          packageJson,
          rootNodeModulesDir: path.join(repoRoot, "node_modules"),
        }),
    );
    const fingerprint = createRuntimeDepsFingerprint(packageJson, pruneConfig, {
      repoRoot,
      rootInstalledRuntimeFingerprint,
    });
    if (fs.existsSync(nodeModulesDir) && stamp?.fingerprint === fingerprint) {
      runPluginPhase(pluginId, "reuse staged runtime deps", () => {});
      continue;
    }
    if (
      runPluginPhase(pluginId, "stage installed root runtime deps", () =>
        stageInstalledRootRuntimeDeps({
          directDependencyPackageRoot,
          fingerprint,
          cheapFingerprint,
          packageJson,
          pluginDir,
          pruneConfig,
          repoRoot,
          stampPath,
        }),
      )
    ) {
      continue;
    }
    try {
      runPluginPhase(pluginId, "fallback install runtime deps", () =>
        installPluginRuntimeDepsWithRetries({
          attempts: installAttempts,
          install: installPluginRuntimeDepsImpl,
          installParams: {
            directDependencyPackageRoot,
            fingerprint,
            cheapFingerprint,
            packageJson,
            pluginDir,
            pluginId,
            pruneConfig,
            repoRoot,
            stampPath,
          },
        }),
      );
    } catch (error) {
      throw createRootRuntimeStagingError({ packageJson, pluginId, cause: error });
    }
  }
}

export const __testing = {
  removeStaleRuntimeDepsTempDirs,
  replaceDirAtomically,
  runNpmInstall,
  writeRuntimeDepsTempOwner,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}
