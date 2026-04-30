import fs from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginBundledRuntimeDepsInstall } from "./bundled-runtime-deps-activity.js";
import {
  installBundledRuntimeDeps,
  installBundledRuntimeDepsAsync,
  repairBundledRuntimeDepsInstallRoot,
  repairBundledRuntimeDepsInstallRootAsync,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps-install.js";
import { readRuntimeDepsJsonObject } from "./bundled-runtime-deps-json.js";
import {
  BUNDLED_RUNTIME_DEPS_LOCK_DIR,
  formatRuntimeDepsLockTimeoutMessage,
  shouldRemoveRuntimeDepsLock,
  withBundledRuntimeDepsFilesystemLock,
} from "./bundled-runtime-deps-lock.js";
import {
  ensureNpmInstallExecutionManifest,
  isRuntimeDepSatisfiedInAnyRoot,
  isRuntimeDepsPlanMaterialized,
  removeLegacyRuntimeDepsManifest,
} from "./bundled-runtime-deps-materialization.js";
import {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  resolveBundledRuntimeDepsNpmRunner,
  resolveBundledRuntimeDepsPnpmRunner,
  type BundledRuntimeDepsNpmRunner,
} from "./bundled-runtime-deps-package-manager.js";
import {
  isSourceCheckoutRoot,
  isWritableDirectory,
  pruneUnknownBundledRuntimeDepsRoots,
  resolveBundledRuntimeDependencyInstallRoot,
  resolveBundledRuntimeDependencyInstallRootInfo,
  resolveBundledRuntimeDependencyInstallRootPlan,
  resolveBundledRuntimeDependencyPackageInstallRoot,
  resolveBundledRuntimeDependencyPackageInstallRootPlan,
  resolveBundledRuntimeDependencyPackageRoot,
  type BundledRuntimeDepsInstallRoot,
  type BundledRuntimeDepsInstallRootPlan,
} from "./bundled-runtime-deps-roots.js";
import {
  collectBundledPluginRuntimeDeps,
  collectMirroredPackageRuntimeDeps,
  createBundledRuntimeDepsPluginIdNormalizer,
  isBundledPluginConfiguredForRuntimeDeps,
  normalizePluginIdSet,
  resolveBundledRuntimeDepsConfiguredModelOwnerPluginIds,
  type BundledPluginRuntimeDepsManifestCache,
  type RuntimeDepConflict,
} from "./bundled-runtime-deps-selection.js";
import {
  collectPackageRuntimeDeps,
  normalizeInstallableRuntimeDepName,
  parseInstallableRuntimeDep,
  type RuntimeDepEntry,
} from "./bundled-runtime-deps-specs.js";
import { normalizePluginsConfigWithResolver } from "./config-normalization-shared.js";

export {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  installBundledRuntimeDeps,
  installBundledRuntimeDepsAsync,
  repairBundledRuntimeDepsInstallRoot,
  repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDepsNpmRunner,
  withBundledRuntimeDepsFilesystemLock,
};
export type { BundledRuntimeDepsNpmRunner };
export type { BundledRuntimeDepsInstallParams } from "./bundled-runtime-deps-install.js";
export type { RuntimeDepEntry } from "./bundled-runtime-deps-specs.js";
export {
  isWritableDirectory,
  pruneUnknownBundledRuntimeDepsRoots,
  resolveBundledRuntimeDependencyInstallRoot,
  resolveBundledRuntimeDependencyInstallRootInfo,
  resolveBundledRuntimeDependencyInstallRootPlan,
  resolveBundledRuntimeDependencyPackageInstallRoot,
  resolveBundledRuntimeDependencyPackageInstallRootPlan,
  resolveBundledRuntimeDependencyPackageRoot,
};
export type {
  BundledRuntimeDepsInstallRoot,
  BundledRuntimeDepsInstallRootPlan,
} from "./bundled-runtime-deps-roots.js";
export type { RuntimeDepConflict } from "./bundled-runtime-deps-selection.js";

export const __testing = {
  formatRuntimeDepsLockTimeoutMessage,
  resolveBundledRuntimeDepsPnpmRunner,
  shouldRemoveRuntimeDepsLock,
};

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
};

export type BundledRuntimeDepsPlan = {
  deps: RuntimeDepEntry[];
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  installSpecs: string[];
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
};

// Packaged bundled plugins (Docker image, npm global install) keep their
// `package.json` next to their entry point; running `npm install <specs>` with
// `cwd: pluginRoot` would make npm resolve the plugin's own `workspace:*`
// dependencies and fail with `EUNSUPPORTEDPROTOCOL`. To avoid that, stage the
// install inside this sub-directory and move the produced `node_modules/` back
// to the plugin root.
const PLUGIN_ROOT_INSTALL_STAGE_DIR = ".openclaw-install-stage";

const registeredBundledRuntimeDepNodePaths = new Set<string>();

function createBundledRuntimeDepsEnsureResult(
  installedSpecs: string[],
): BundledRuntimeDepsEnsureResult {
  return { installedSpecs };
}

function withBundledRuntimeDepsInstallRootLock<T>(installRoot: string, run: () => T): T {
  return withBundledRuntimeDepsFilesystemLock(installRoot, BUNDLED_RUNTIME_DEPS_LOCK_DIR, run);
}

function mergeRuntimeDepEntries(deps: readonly RuntimeDepEntry[]): RuntimeDepEntry[] {
  const bySpec = new Map<string, RuntimeDepEntry>();
  for (const dep of deps) {
    const spec = `${dep.name}@${dep.version}`;
    const existing = bySpec.get(spec);
    if (!existing) {
      bySpec.set(spec, { ...dep, pluginIds: [...dep.pluginIds] });
      continue;
    }
    existing.pluginIds = [...new Set([...existing.pluginIds, ...dep.pluginIds])].toSorted(
      (left, right) => left.localeCompare(right),
    );
  }
  return [...bySpec.values()].toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

export function registerBundledRuntimeDependencyNodePath(rootDir: string): void {
  const nodeModulesDir = path.join(rootDir, "node_modules");
  if (registeredBundledRuntimeDepNodePaths.has(nodeModulesDir) || !fs.existsSync(nodeModulesDir)) {
    return;
  }
  const currentPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  process.env.NODE_PATH = [
    nodeModulesDir,
    ...currentPaths.filter((entry) => entry !== nodeModulesDir),
  ].join(path.delimiter);
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
  registeredBundledRuntimeDepNodePaths.add(nodeModulesDir);
}

export function clearBundledRuntimeDependencyNodePaths(): void {
  if (registeredBundledRuntimeDepNodePaths.size === 0) {
    return;
  }
  const retainedPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !registeredBundledRuntimeDepNodePaths.has(entry));
  if (retainedPaths.length > 0) {
    process.env.NODE_PATH = retainedPaths.join(path.delimiter);
  } else {
    delete process.env.NODE_PATH;
  }
  registeredBundledRuntimeDepNodePaths.clear();
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
}

export function createBundledRuntimeDepsInstallSpecs(params: {
  deps: readonly { name: string; version: string }[];
}): string[] {
  return params.deps
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function createBundledRuntimeDepsPlan(params: {
  deps: readonly RuntimeDepEntry[];
  conflicts: readonly RuntimeDepConflict[];
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
}): BundledRuntimeDepsPlan {
  const deps = mergeRuntimeDepEntries(params.deps);
  return {
    deps,
    missing: deps.filter(
      (dep) => !isRuntimeDepSatisfiedInAnyRoot(dep, params.installRootPlan.searchRoots),
    ),
    conflicts: [...params.conflicts],
    installSpecs: createBundledRuntimeDepsInstallSpecs({ deps }),
    installRootPlan: params.installRootPlan,
  };
}

export function scanBundledPluginRuntimeDeps(params: {
  packageRoot: string;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
  selectedPluginIds?: readonly string[];
  includeConfiguredChannels?: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  deps: RuntimeDepEntry[];
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return { deps: [], missing: [], conflicts: [] };
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return { deps: [], missing: [], conflicts: [] };
  }
  const manifestCache: BundledPluginRuntimeDepsManifestCache = new Map();
  const normalizePluginId =
    params.config || params.pluginIds || params.selectedPluginIds
      ? createBundledRuntimeDepsPluginIdNormalizer({
          extensionsDir,
          manifestCache,
        })
      : undefined;
  const { deps, conflicts, pluginIds } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    config: params.config,
    pluginIds: normalizePluginIdSet(params.pluginIds, normalizePluginId),
    selectedPluginIds: normalizePluginIdSet(params.selectedPluginIds, normalizePluginId),
    includeConfiguredChannels: params.includeConfiguredChannels,
    manifestCache,
    ...(normalizePluginId ? { normalizePluginId } : {}),
  });
  const packageRuntimeDeps =
    pluginIds.length > 0 ? collectMirroredPackageRuntimeDeps(params.packageRoot) : [];
  const installRootPlan = resolveBundledRuntimeDependencyPackageInstallRootPlan(
    params.packageRoot,
    {
      env: params.env,
    },
  );
  const plan = createBundledRuntimeDepsPlan({
    deps: [...deps, ...packageRuntimeDeps],
    conflicts,
    installRootPlan,
  });
  return { deps: plan.deps, missing: plan.missing, conflicts: plan.conflicts };
}

export function createBundledRuntimeDependencyAliasMap(params: {
  pluginRoot: string;
  installRoot: string;
}): Record<string, string> {
  if (path.resolve(params.installRoot) === path.resolve(params.pluginRoot)) {
    return {};
  }
  const packageJson = readRuntimeDepsJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const name of Object.keys(collectPackageRuntimeDeps(packageJson)).toSorted((a, b) =>
    a.localeCompare(b),
  )) {
    const normalizedName = normalizeInstallableRuntimeDepName(name);
    if (!normalizedName) {
      continue;
    }
    const target = path.join(params.installRoot, "node_modules", ...normalizedName.split("/"));
    if (fs.existsSync(path.join(target, "package.json"))) {
      aliases[normalizedName] = target;
    }
  }
  return aliases;
}

export function ensureBundledPluginRuntimeDeps(params: {
  pluginId: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): BundledRuntimeDepsEnsureResult {
  const extensionsDir = path.dirname(params.pluginRoot);
  const manifestCache: BundledPluginRuntimeDepsManifestCache = new Map();
  const normalizePluginId = params.config
    ? createBundledRuntimeDepsPluginIdNormalizer({
        extensionsDir,
        manifestCache,
      })
    : undefined;
  const plugins = params.config
    ? normalizePluginsConfigWithResolver(params.config.plugins, normalizePluginId)
    : undefined;
  if (
    params.config &&
    plugins &&
    !isBundledPluginConfiguredForRuntimeDeps({
      config: params.config,
      plugins,
      pluginId: params.pluginId,
      pluginDir: params.pluginRoot,
      configuredModelOwnerPluginIds: resolveBundledRuntimeDepsConfiguredModelOwnerPluginIds({
        config: params.config,
        extensionsDir,
        manifestCache,
      }),
      manifestCache,
    })
  ) {
    return createBundledRuntimeDepsEnsureResult([]);
  }
  const packageJson = readRuntimeDepsJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return createBundledRuntimeDepsEnsureResult([]);
  }
  const pluginDeps = Object.entries(collectPackageRuntimeDeps(packageJson))
    .map(([name, rawVersion]) => parseInstallableRuntimeDep(name, rawVersion))
    .filter((entry): entry is { name: string; version: string } => Boolean(entry));
  const pluginDepEntries = pluginDeps.map((dep) => ({
    name: dep.name,
    version: dep.version,
    pluginIds: [params.pluginId],
  }));

  const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(params.pluginRoot, {
    env: params.env,
  });
  const installRoot = installRootPlan.installRoot;
  const packageRoot = resolveBundledRuntimeDependencyPackageRoot(params.pluginRoot);
  const usePackageLevelPlan =
    packageRoot && path.resolve(installRoot) !== path.resolve(params.pluginRoot);
  let deps = pluginDepEntries;
  if (usePackageLevelPlan && packageRoot) {
    const packagePlan = collectBundledPluginRuntimeDeps({
      extensionsDir,
      ...(params.config ? { config: params.config } : {}),
      manifestCache,
      ...(normalizePluginId ? { normalizePluginId } : {}),
    });
    if (packagePlan.conflicts.length === 0 && packagePlan.deps.length > 0) {
      deps = mergeRuntimeDepEntries([
        ...packagePlan.deps,
        ...collectMirroredPackageRuntimeDeps(packageRoot),
      ]);
    } else {
      deps = mergeRuntimeDepEntries([
        ...pluginDepEntries,
        ...collectMirroredPackageRuntimeDeps(packageRoot),
      ]);
    }
  }
  if (deps.length === 0) {
    return createBundledRuntimeDepsEnsureResult([]);
  }
  const plan = createBundledRuntimeDepsPlan({
    deps,
    conflicts: [],
    installRootPlan,
  });
  return withBundledRuntimeDepsInstallRootLock(installRoot, () => {
    const installSpecs = plan.installSpecs;
    if (isRuntimeDepsPlanMaterialized(installRoot, installSpecs)) {
      removeLegacyRuntimeDepsManifest(installRoot);
      return createBundledRuntimeDepsEnsureResult([]);
    }
    const isPluginRootInstall = path.resolve(installRoot) === path.resolve(params.pluginRoot);
    const installExecutionRoot = isPluginRootInstall
      ? path.join(installRoot, PLUGIN_ROOT_INSTALL_STAGE_DIR)
      : undefined;
    removeLegacyRuntimeDepsManifest(installRoot);

    const install =
      params.installDeps ??
      ((installParams) => {
        return installBundledRuntimeDeps({
          installRoot: installParams.installRoot,
          installExecutionRoot: installParams.installExecutionRoot,
          missingSpecs: installParams.installSpecs ?? installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
        });
      });
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot,
      missingSpecs: installSpecs,
      installSpecs,
      pluginId: params.pluginId,
    });
    if (!installExecutionRoot) {
      ensureNpmInstallExecutionManifest(installRoot, installSpecs);
    }
    try {
      install({
        installRoot,
        ...(installExecutionRoot ? { installExecutionRoot } : {}),
        missingSpecs: installSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    removeLegacyRuntimeDepsManifest(installRoot);
    return createBundledRuntimeDepsEnsureResult(installSpecs);
  });
}
