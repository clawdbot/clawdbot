import fs from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginBundledRuntimeDepsInstall } from "./bundled-runtime-deps-activity.js";
import {
  installBundledRuntimeDeps,
  repairBundledRuntimeDepsInstallRootAsync,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps-install.js";
import { readRuntimeDepsJsonObject } from "./bundled-runtime-deps-json.js";
import {
  BUNDLED_RUNTIME_DEPS_LOCK_DIR,
  removeRuntimeDepsLockIfStale,
  withBundledRuntimeDepsFilesystemLock,
} from "./bundled-runtime-deps-lock.js";
import {
  ensureNpmInstallExecutionManifest,
  isRuntimeDepSatisfiedInAnyRoot,
  isRuntimeDepsPlanMaterialized,
  linkRuntimeDepsNodeModulesFromRoot,
  removeLegacyRuntimeDepsManifest,
  removeRuntimeDepsNodeModulesSymlink,
} from "./bundled-runtime-deps-materialization.js";
import {
  isSourceCheckoutRoot,
  listSiblingExternalBundledRuntimeDepsRoots,
  pruneSiblingExternalBundledRuntimeDepsRoots,
  pruneUnknownBundledRuntimeDepsRoots,
  resolveBundledRuntimeDependencyInstallRootPlan,
  resolveBundledRuntimeDependencyPackageInstallRootPlan,
  resolveBundledRuntimeDependencyPackageRoot,
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
import {
  normalizePluginsConfigWithResolver,
  type NormalizePluginId,
} from "./config-normalization-shared.js";

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
};

export class BundledRuntimeDepsMissingError extends Error {
  readonly pluginId: string;
  readonly installRoot: string;
  readonly missingSpecs: string[];

  constructor(params: { pluginId: string; installRoot: string; missingSpecs: string[] }) {
    super(
      `bundled runtime dependencies missing for ${params.pluginId}: ${params.missingSpecs.join(", ")}. Run "openclaw plugins deps --repair" to repair them.`,
    );
    this.name = "BundledRuntimeDepsMissingError";
    this.pluginId = params.pluginId;
    this.installRoot = params.installRoot;
    this.missingSpecs = params.missingSpecs;
  }
}

export type BundledRuntimeDepsPlan = {
  deps: RuntimeDepEntry[];
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  installSpecs: string[];
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
};

export type BundledRuntimeDepsPackagePlan = BundledRuntimeDepsPlan & {
  packageRoot: string;
  missingSpecs: string[];
};

export type BundledRuntimeDepsPackagePlanParams = {
  packageRoot: string;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
  exactPluginIds?: readonly string[];
  includeConfiguredChannels?: boolean;
  includeEnabledByDefaultPlugins?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type RepairBundledRuntimeDepsPackagePlanResult = {
  plan: BundledRuntimeDepsPackagePlan;
  repairedSpecs: string[];
  reusedSpecs?: string[];
  reusedFromRoot?: string;
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

function createBundledRuntimeDepsInstallSpecs(params: {
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

function hasPreviousIncompleteInstall(
  installRoot: string,
  installSpecs: readonly string[],
): boolean {
  return (
    fs.existsSync(path.join(installRoot, "node_modules")) &&
    !isRuntimeDepsPlanMaterialized(installRoot, installSpecs)
  );
}

function findReusableBundledRuntimeDepsRoot(params: {
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
  installSpecs: readonly string[];
  env: NodeJS.ProcessEnv;
}): string | null {
  if (!params.installRootPlan.external || params.installSpecs.length === 0) {
    return null;
  }
  for (const root of listSiblingExternalBundledRuntimeDepsRoots({
    installRoot: params.installRootPlan.installRoot,
    env: params.env,
  })) {
    if (
      !hasActiveBundledRuntimeDepsInstallLock(root) &&
      hasConcreteBundledRuntimeDepsNodeModules(root) &&
      isRuntimeDepsPlanMaterialized(root, params.installSpecs)
    ) {
      return root;
    }
  }
  return null;
}

function hasActiveBundledRuntimeDepsInstallLock(root: string): boolean {
  const lockDir = path.join(root, BUNDLED_RUNTIME_DEPS_LOCK_DIR);
  return fs.existsSync(lockDir) && !removeRuntimeDepsLockIfStale(lockDir, Date.now());
}

function hasConcreteBundledRuntimeDepsNodeModules(root: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(root, "node_modules"));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function arePackageLevelRuntimeDepsAlreadyMaterialized(params: {
  installRoot: string;
  packageRoot: string;
  pluginDeps: readonly RuntimeDepEntry[];
}): boolean {
  const installSpecs = createBundledRuntimeDepsInstallSpecs({
    deps: [...params.pluginDeps, ...collectMirroredPackageRuntimeDeps(params.packageRoot)],
  });
  return installSpecs.length > 0 && isRuntimeDepsPlanMaterialized(params.installRoot, installSpecs);
}

function collectPackageLevelRuntimeDepsForPlugin(params: {
  extensionsDir: string;
  pluginId: string;
  pluginDepEntries: readonly RuntimeDepEntry[];
  config?: OpenClawConfig;
  manifestCache: BundledPluginRuntimeDepsManifestCache;
  normalizePluginId?: NormalizePluginId;
}): { deps: readonly RuntimeDepEntry[]; conflicts: readonly RuntimeDepConflict[] } {
  if (!params.config) {
    return { deps: params.pluginDepEntries, conflicts: [] };
  }
  return collectBundledPluginRuntimeDeps({
    extensionsDir: params.extensionsDir,
    config: params.config,
    pluginIds: new Set([params.pluginId]),
    manifestCache: params.manifestCache,
    ...(params.normalizePluginId ? { normalizePluginId: params.normalizePluginId } : {}),
  });
}

type RuntimeDepsReuseResult = { status: "materialized" } | { status: "reused"; sourceRoot: string };

function tryReuseBundledRuntimeDepsRoot(params: {
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
  installSpecs: readonly string[];
  env: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}): RuntimeDepsReuseResult | null {
  const installRoot = params.installRootPlan.installRoot;
  if (isRuntimeDepsPlanMaterialized(installRoot, params.installSpecs)) {
    removeLegacyRuntimeDepsManifest(installRoot);
    return { status: "materialized" };
  }
  const reusableRoot = findReusableBundledRuntimeDepsRoot(params);
  if (!reusableRoot) {
    return null;
  }
  const nodeModulesPath = path.join(installRoot, "node_modules");
  try {
    fs.lstatSync(nodeModulesPath);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  ensureNpmInstallExecutionManifest(installRoot, params.installSpecs);
  if (
    !linkRuntimeDepsNodeModulesFromRoot({
      sourceRoot: reusableRoot,
      targetRoot: installRoot,
    })
  ) {
    return null;
  }
  if (!isRuntimeDepsPlanMaterialized(installRoot, params.installSpecs)) {
    removeRuntimeDepsNodeModulesSymlink(installRoot);
    return null;
  }
  params.onProgress?.(`Reusing bundled plugin runtime deps from ${reusableRoot}`);
  return { status: "reused", sourceRoot: reusableRoot };
}

export function createBundledRuntimeDepsPackagePlan(
  params: BundledRuntimeDepsPackagePlanParams,
): BundledRuntimeDepsPackagePlan {
  const installRootPlan = resolveBundledRuntimeDependencyPackageInstallRootPlan(
    params.packageRoot,
    {
      env: params.env,
    },
  );
  const emptyPlan = () => {
    const plan = createBundledRuntimeDepsPlan({
      deps: [],
      conflicts: [],
      installRootPlan,
    });
    return {
      ...plan,
      packageRoot: params.packageRoot,
      missingSpecs: [],
    };
  };
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return emptyPlan();
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return emptyPlan();
  }
  const manifestCache: BundledPluginRuntimeDepsManifestCache = new Map();
  const normalizePluginId =
    params.config || params.pluginIds || params.exactPluginIds
      ? createBundledRuntimeDepsPluginIdNormalizer({
          extensionsDir,
          manifestCache,
        })
      : undefined;
  const exactPluginIds = normalizePluginIdSet(params.exactPluginIds, normalizePluginId);
  const scopedPluginIds = normalizePluginIdSet(params.pluginIds, normalizePluginId);
  const { deps, conflicts, pluginIds } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    ...(params.config ? { config: params.config } : {}),
    ...(exactPluginIds ? { exactPluginIds } : {}),
    ...(!exactPluginIds && scopedPluginIds ? { pluginIds: scopedPluginIds } : {}),
    ...(!exactPluginIds && params.includeConfiguredChannels !== undefined
      ? { includeConfiguredChannels: params.includeConfiguredChannels }
      : {}),
    ...(!exactPluginIds && params.includeEnabledByDefaultPlugins !== undefined
      ? { includeEnabledByDefaultPlugins: params.includeEnabledByDefaultPlugins }
      : {}),
    manifestCache,
    ...(normalizePluginId ? { normalizePluginId } : {}),
  });
  const packageRuntimeDeps =
    pluginIds.length > 0 ? collectMirroredPackageRuntimeDeps(params.packageRoot) : [];
  const plan = createBundledRuntimeDepsPlan({
    deps: [...deps, ...packageRuntimeDeps],
    conflicts,
    installRootPlan,
  });
  const missing = hasPreviousIncompleteInstall(installRootPlan.installRoot, plan.installSpecs)
    ? plan.deps
    : plan.missing;
  return {
    ...plan,
    missing,
    packageRoot: params.packageRoot,
    missingSpecs: createBundledRuntimeDepsInstallSpecs({ deps: missing }),
  };
}

export async function repairBundledRuntimeDepsPackagePlanAsync(params: {
  packageRoot: string;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
  exactPluginIds?: readonly string[];
  includeConfiguredChannels?: boolean;
  includeEnabledByDefaultPlugins?: boolean;
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => Promise<void> | void;
  onProgress?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<RepairBundledRuntimeDepsPackagePlanResult> {
  pruneUnknownBundledRuntimeDepsRoots({
    env: params.env,
    ...(params.warn ? { warn: params.warn } : {}),
  });
  const plan = createBundledRuntimeDepsPackagePlan(params);
  if (plan.missingSpecs.length === 0) {
    pruneSiblingExternalBundledRuntimeDepsRoots({
      installRoot: plan.installRootPlan.installRoot,
      ...(params.warn ? { warn: params.warn } : {}),
    });
    return { plan, repairedSpecs: [] };
  }
  const reuseResult = withBundledRuntimeDepsInstallRootLock(plan.installRootPlan.installRoot, () =>
    tryReuseBundledRuntimeDepsRoot({
      installRootPlan: plan.installRootPlan,
      installSpecs: plan.installSpecs,
      env: params.env,
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    }),
  );
  if (reuseResult) {
    const refreshedPlan = createBundledRuntimeDepsPackagePlan(params);
    if (reuseResult.status === "materialized") {
      pruneSiblingExternalBundledRuntimeDepsRoots({
        installRoot: refreshedPlan.installRootPlan.installRoot,
        ...(params.warn ? { warn: params.warn } : {}),
      });
    }
    return {
      plan: refreshedPlan,
      repairedSpecs: [],
      ...(reuseResult.status === "reused"
        ? {
            reusedSpecs: refreshedPlan.installSpecs,
            reusedFromRoot: reuseResult.sourceRoot,
          }
        : {}),
    };
  }
  const result = await repairBundledRuntimeDepsInstallRootAsync({
    installRoot: plan.installRootPlan.installRoot,
    missingSpecs: plan.missingSpecs,
    installSpecs: plan.installSpecs,
    env: params.env,
    ...(params.installDeps
      ? {
          installDeps: async (installParams) => {
            await params.installDeps?.(installParams);
          },
        }
      : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    ...(params.warn ? { warn: params.warn } : {}),
  });
  pruneSiblingExternalBundledRuntimeDepsRoots({
    installRoot: plan.installRootPlan.installRoot,
    ...(params.warn ? { warn: params.warn } : {}),
  });
  return { plan, repairedSpecs: result.installSpecs };
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
  installMissingDeps?: boolean;
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
    packageRoot &&
    !isSourceCheckoutRoot(packageRoot) &&
    path.resolve(installRoot) !== path.resolve(params.pluginRoot);
  let deps = pluginDepEntries;
  if (usePackageLevelPlan && packageRoot) {
    const requestedPluginPlan = collectPackageLevelRuntimeDepsForPlugin({
      extensionsDir,
      pluginId: params.pluginId,
      pluginDepEntries,
      ...(params.config ? { config: params.config } : {}),
      manifestCache,
      ...(normalizePluginId ? { normalizePluginId } : {}),
    });
    if (
      requestedPluginPlan.conflicts.length === 0 &&
      arePackageLevelRuntimeDepsAlreadyMaterialized({
        installRoot,
        packageRoot,
        pluginDeps: requestedPluginPlan.deps,
      })
    ) {
      removeLegacyRuntimeDepsManifest(installRoot);
      return createBundledRuntimeDepsEnsureResult([]);
    }
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
    if (
      tryReuseBundledRuntimeDepsRoot({
        installRootPlan: plan.installRootPlan,
        installSpecs,
        env: params.env,
      })
    ) {
      return createBundledRuntimeDepsEnsureResult([]);
    }
    if (params.installMissingDeps === false) {
      throw new BundledRuntimeDepsMissingError({
        pluginId: params.pluginId,
        installRoot,
        missingSpecs: installSpecs,
      });
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
          force: true,
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
