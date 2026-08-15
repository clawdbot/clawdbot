// Builds stable snapshots of plugin registry contributions.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { buildLegacyBundledRootPath } from "./bundled-load-path-aliases.js";
import { listBundledSourceOverlayDirs } from "./bundled-source-overlays.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  appendPluginControlPlaneWorkspaceDiagnostic,
  resolvePluginControlPlaneWorkspace,
} from "./control-plane-workspace.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { discoverConfiguredPluginLoadPaths, type PluginDiscoveryResult } from "./discovery.js";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import { safeFileSignature, safeHashFile } from "./installed-plugin-index-hash.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  refreshPersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  extractPluginInstallRecordsFromInstalledPluginIndex,
  getInstalledPluginRecord,
  hasInstalledPluginIndexWorkspaceScopeMismatch,
  hasMissingConfigPathActivationMetadata,
  isInstalledPluginEnabled,
  loadInstalledPluginIndexWithDiscovery,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { hasMissingInstalledPluginOwnerMetadata } from "./installed-plugin-package-ownership.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import { getPackageManifestMetadata, type PackageManifest } from "./manifest.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import type { PluginRegistrySnapshotSource } from "./plugin-registry-snapshot.types.js";
import { resolvePluginSourceRoots } from "./roots.js";

function resolvePluginRegistryContent(
  index: InstalledPluginIndex,
  comparePackageJsonPath: boolean,
  excludedPlugins?: ReadonlyMap<string, string>,
): unknown {
  const {
    generatedAtMs: _generatedAtMs,
    refreshReason: _refreshReason,
    warning: _warning,
    ...content
  } = index;
  const excludedRoots = [...(excludedPlugins?.values() ?? [])].map((root) => path.resolve(root));
  const exclusionPathCache = new Map<string, string>();
  return {
    ...content,
    diagnostics: excludedPlugins
      ? content.diagnostics.filter(
          (diagnostic) =>
            !(
              (diagnostic.pluginId && excludedPlugins.has(diagnostic.pluginId)) ||
              (diagnostic.source &&
                excludedRoots.some((root) =>
                  isContainedPluginPath(root, diagnostic.source!, exclusionPathCache),
                ))
            ),
        )
      : content.diagnostics,
    installRecords: excludedPlugins
      ? Object.fromEntries(
          Object.entries(content.installRecords).filter(
            ([pluginId]) => !excludedPlugins.has(pluginId),
          ),
        )
      : content.installRecords,
    plugins: content.plugins
      .filter((plugin) => !excludedPlugins?.has(plugin.pluginId))
      .map((plugin) => {
        const {
          doctorContractFile: _doctorContractFile,
          manifestFile: _manifestFile,
          packageBuild,
          packageJson,
          ...record
        } = plugin;
        // Compare the durable package-build contract. The store intentionally drops
        // build-only metadata that runtime selection does not consume.
        const stableRecord = Object.assign(
          record,
          packageBuild === undefined
            ? {}
            : {
                packageBuild:
                  packageBuild.bundledDist === undefined
                    ? {}
                    : { bundledDist: packageBuild.bundledDist },
              },
        );
        if (!packageJson) {
          return stableRecord;
        }
        if (!comparePackageJsonPath) {
          return stableRecord;
        }
        const {
          fileSignature: _fileSignature,
          path: packageJsonPath,
          ...stablePackageJson
        } = packageJson;
        return Object.assign(stableRecord, {
          packageJson: Object.assign(stablePackageJson, { path: packageJsonPath }),
        });
      }),
  };
}

export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type { PluginRegistrySnapshotSource } from "./plugin-registry-snapshot.types.js";
type PluginRegistrySnapshotDiagnosticCode =
  | "persisted-registry-missing"
  | "persisted-registry-stale-policy"
  | "persisted-registry-stale-source";

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code: PluginRegistrySnapshotDiagnosticCode;
  message: string;
};

type PluginRegistrySnapshotResult = {
  snapshot: PluginRegistrySnapshot;
  source: PluginRegistrySnapshotSource;
  diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
  discovery?: PluginDiscoveryResult;
  manifestRegistry?: PluginManifestRegistry;
};

export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
    allowCurrent?: boolean;
  };

type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
};

function canReuseCurrentPluginMetadataSnapshot(params: LoadPluginRegistryParams): boolean {
  return (
    params.allowCurrent !== false &&
    params.preferPersisted !== false &&
    params.stateDir === undefined &&
    params.filePath === undefined &&
    params.pluginIndexFilePath === undefined &&
    params.installRecords === undefined &&
    params.candidates === undefined &&
    params.diagnostics === undefined &&
    params.discovery === undefined &&
    params.now === undefined
  );
}

function loadCurrentPluginRegistrySnapshotResult(
  params: LoadPluginRegistryParams,
): PluginRegistrySnapshotResult | undefined {
  if (!canReuseCurrentPluginMetadataSnapshot(params)) {
    return undefined;
  }
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env ?? process.env,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (!current) {
    return undefined;
  }
  return {
    snapshot: current.index,
    source:
      current.registrySource ?? (current.registryDiagnostics.length > 0 ? "derived" : "provided"),
    diagnostics: current.registryDiagnostics,
    ...(current.discovery ? { discovery: current.discovery } : {}),
    manifestRegistry: current.manifestRegistry,
  };
}

function fileContentMatches(
  filePath: string,
  hash: string,
  signature?: InstalledPluginIndexRecord["manifestFile"],
  trustSignature = true,
): boolean {
  const current = safeFileSignature(filePath);
  if (!current) {
    return false;
  }
  if (
    trustSignature &&
    signature?.ctimeMs !== undefined &&
    current.size === signature.size &&
    current.mtimeMs === signature.mtimeMs &&
    current.ctimeMs === signature.ctimeMs
  ) {
    return true;
  }
  return safeHashFile({ filePath, diagnostics: [], required: false }) === hash;
}

function isContainedPluginPath(
  rootPath: string,
  targetPath: string,
  cache: Map<string, string>,
): boolean {
  // Project unresolved suffixes from the nearest real ancestor so missing disabled
  // artifacts stay inspectable without accepting symlink or path-alias escapes.
  const resolveProjectedPath = (inputPath: string): string | null => {
    const target = path.resolve(inputPath);
    for (let cursor = target; ; cursor = path.dirname(cursor)) {
      try {
        fs.lstatSync(cursor);
        const realCursor = safeRealpathSync(cursor, cache);
        return realCursor ? path.resolve(realCursor, path.relative(cursor, target)) : null;
      } catch {
        if (cursor === path.dirname(cursor)) {
          return null;
        }
      }
    }
  };
  const root = resolveProjectedPath(rootPath);
  const target = resolveProjectedPath(targetPath);
  return Boolean(root && target && isPathInside(root, target));
}

function hasStaleDoctorContractFile(
  plugin: InstalledPluginIndexRecord,
  rootExists: boolean,
): boolean {
  if (!rootExists && !plugin.enabled) {
    return false;
  }
  const contractPath = resolvePluginDoctorContractArtifactPath(plugin.rootDir);
  return contractPath
    ? !plugin.doctorContractHash ||
        !fileContentMatches(contractPath, plugin.doctorContractHash, plugin.doctorContractFile)
    : plugin.doctorContractHash !== undefined || plugin.doctorContractFile !== undefined;
}

function hasStalePersistedPluginFiles(index: InstalledPluginIndex): boolean {
  const realpathCache = new Map<string, string>();
  return index.plugins.some((plugin) => {
    if (!isContainedPluginPath(plugin.rootDir, plugin.rootDir, realpathCache)) {
      return true;
    }
    const rootExists = fs.existsSync(plugin.rootDir);
    if (!rootExists && plugin.enabled) {
      return true;
    }
    for (const artifactPath of [plugin.source, plugin.setupSource, plugin.manifestPath]) {
      if (artifactPath && !isContainedPluginPath(plugin.rootDir, artifactPath, realpathCache)) {
        return true;
      }
    }
    if (
      plugin.enabled &&
      ((plugin.source ? !fs.existsSync(plugin.source) : false) ||
        (plugin.setupSource ? !fs.existsSync(plugin.setupSource) : false))
    ) {
      return true;
    }
    if (!hasOptionalMissingPluginManifestFile(plugin)) {
      if (!fs.existsSync(plugin.manifestPath)) {
        if (plugin.enabled) {
          return true;
        }
      } else if (
        !fileContentMatches(plugin.manifestPath, plugin.manifestHash, plugin.manifestFile)
      ) {
        return true;
      }
    }
    if (hasStaleDoctorContractFile(plugin, rootExists)) {
      return true;
    }
    if (!plugin.packageJson) {
      return false;
    }
    const packageJsonPath = path.resolve(plugin.rootDir, plugin.packageJson.path);
    if (!isContainedPluginPath(plugin.rootDir, packageJsonPath, realpathCache)) {
      return true;
    }
    if (!fs.existsSync(packageJsonPath)) {
      return plugin.enabled;
    }
    if (!isRealPathInside(plugin.rootDir, packageJsonPath, realpathCache)) {
      return true;
    }
    return !fileContentMatches(
      packageJsonPath,
      plugin.packageJson.hash,
      plugin.packageJson.fileSignature,
      plugin.origin === "bundled",
    );
  });
}

function isRealPathInside(
  parentPath: string,
  childPath: string,
  cache: Map<string, string>,
): boolean {
  const parent = safeRealpathSync(parentPath, cache);
  const child = safeRealpathSync(childPath, cache);
  return Boolean(parent && child && isPathInside(parent, child));
}

function hasMismatchedPersistedBundledRoot(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): boolean {
  const bundledRoot = resolveBundledPluginsDir(env);
  if (!bundledRoot) {
    return false;
  }
  const realpathCache = new Map<string, string>();
  const overlays = listBundledSourceOverlayDirs({ bundledRoot, env });
  const legacyRoot = buildLegacyBundledRootPath(bundledRoot);
  const sourceCheckout =
    legacyRoot &&
    fs.existsSync(path.join(path.dirname(legacyRoot), ".git")) &&
    fs.existsSync(path.join(path.dirname(legacyRoot), "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(path.dirname(legacyRoot), "src"));
  return index.plugins.some((plugin) => {
    if (plugin.origin !== "bundled") {
      return false;
    }
    if (!plugin.enabled && !fs.existsSync(plugin.rootDir)) {
      const allowedRoots = [bundledRoot, ...overlays, ...(legacyRoot ? [legacyRoot] : [])];
      return !allowedRoots.some((root) =>
        isContainedPluginPath(root, plugin.rootDir, realpathCache),
      );
    }
    if (isRealPathInside(bundledRoot, plugin.rootDir, realpathCache)) {
      if (!sourceCheckout) {
        return false;
      }
      const resolvedBundledRoot = safeRealpathSync(bundledRoot, realpathCache) ?? bundledRoot;
      const resolvedPluginRoot = safeRealpathSync(plugin.rootDir, realpathCache) ?? plugin.rootDir;
      const sourcePackage = tryReadJsonSync<PackageManifest>(
        path.join(
          legacyRoot,
          path.relative(resolvedBundledRoot, resolvedPluginRoot),
          "package.json",
        ),
      );
      return getPackageManifestMetadata(sourcePackage ?? undefined)?.build?.bundledDist === false;
    }
    return (
      !overlays.some((root) => isRealPathInside(root, plugin.rootDir, realpathCache)) &&
      !(
        plugin.packageBuild?.bundledDist === false &&
        legacyRoot &&
        isRealPathInside(legacyRoot, plugin.rootDir, realpathCache)
      )
    );
  });
}

function hasRecoveredInstallRecordsMissingFromPersistedIndex(
  index: InstalledPluginIndex,
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): boolean {
  const installRecords = loadInstalledPluginIndexInstallRecordsSync({
    env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.filePath
      ? { filePath: params.filePath }
      : params.pluginIndexFilePath
        ? { filePath: params.pluginIndexFilePath }
        : {}),
  });
  // A durable owner can outlive removed package bytes. Lifecycle mutations fail
  // closed without child rows; registry recovery only needs to detect records
  // that are absent from the persisted top-level ledger.
  return Object.keys(installRecords).some((pluginId) => !index.installRecords?.[pluginId]);
}

function requiresDerivedRegistryValidation(
  index: InstalledPluginIndex,
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
  hasStalePluginFiles: () => boolean,
): boolean {
  return (
    hasInstalledPluginIndexWorkspaceScopeMismatch(index, params.workspaceDir) ||
    params.candidates !== undefined ||
    params.discovery !== undefined ||
    params.diagnostics !== undefined ||
    params.installRecords !== undefined ||
    normalizePluginsConfig(params.config?.plugins).loadPaths.length > 0 ||
    hasMissingConfigPathActivationMetadata(index) ||
    hasMissingInstalledPluginOwnerMetadata(index, env) ||
    index.diagnostics.some(({ pluginId, source }) =>
      Boolean(pluginId && source && path.isAbsolute(source) && !fs.existsSync(source)),
    ) ||
    hasMismatchedPersistedBundledRoot(index, env) ||
    hasStalePluginFiles() ||
    hasRecoveredInstallRecordsMissingFromPersistedIndex(index, params, env) ||
    hasConfiguredGlobalSourcePluginMissingFromPersistedIndex(params, index, env)
  );
}

function collectConfiguredPluginIds(config: LoadPluginRegistryParams["config"]): Set<string> {
  const plugins = normalizePluginsConfig(config?.plugins);
  const pluginIds = new Set<string>();
  for (const pluginId of Object.keys(plugins.entries)) {
    pluginIds.add(pluginId);
  }
  for (const pluginId of plugins.allow) {
    pluginIds.add(pluginId);
  }
  for (const pluginId of Object.values(plugins.slots)) {
    if (typeof pluginId === "string" && pluginId.trim() && pluginId !== "none") {
      pluginIds.add(pluginId);
    }
  }
  return pluginIds;
}

function hasConfiguredGlobalSourcePluginMissingFromPersistedIndex(
  params: LoadPluginRegistryParams,
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): boolean {
  const configuredPluginIds = collectConfiguredPluginIds(params.config);
  const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
  const missingConfiguredPluginIds = new Set(
    [...configuredPluginIds].filter((pluginId) => !persistedPluginIds.has(pluginId)),
  );
  if (missingConfiguredPluginIds.size === 0) {
    return false;
  }
  const globalExtensionsRoot = resolvePluginSourceRoots({
    workspaceDir: params.workspaceDir,
    env,
  }).global;
  const discovery = discoverConfiguredPluginLoadPaths({
    loadPaths: [globalExtensionsRoot],
    workspaceDir: params.workspaceDir,
    env,
  });
  const registry = loadPluginManifestRegistryCore({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(index),
  });
  return registry.plugins.some((plugin) => missingConfiguredPluginIds.has(plugin.id));
}

export function loadPluginRegistrySnapshotWithMetadata(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshotResult {
  if (params.index) {
    return {
      snapshot: params.index,
      source: "provided",
      diagnostics: [],
    };
  }
  const current = loadCurrentPluginRegistrySnapshotResult(params);
  if (current) {
    return current;
  }

  const env = params.env ?? process.env;
  const persistedReadsEnabled = params.preferPersisted !== false;
  if (!persistedReadsEnabled) {
    const derived = loadInstalledPluginIndexWithDiscovery({
      ...params,
      installRecords: params.installRecords ?? {},
    });
    return {
      snapshot: derived.index,
      source: "derived",
      diagnostics: [],
      discovery: derived.discovery,
      manifestRegistry: derived.manifestRegistry,
    };
  }

  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  const persistedIndex = readPersistedInstalledPluginIndexSync(params);
  let stalePluginFiles: boolean | undefined;
  const hasStalePluginFiles = () =>
    (stalePluginFiles ??= persistedIndex ? hasStalePersistedPluginFiles(persistedIndex) : false);
  if (!persistedIndex) {
    diagnostics.push({
      level: "info",
      code: "persisted-registry-missing",
      message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
    });
  } else if (
    params.config &&
    persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
  ) {
    diagnostics.push({
      level: "warn",
      code: "persisted-registry-stale-policy",
      message:
        "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
    });
  } else if (!requiresDerivedRegistryValidation(persistedIndex, params, env, hasStalePluginFiles)) {
    return {
      snapshot: persistedIndex,
      source: "persisted",
      diagnostics,
    };
  }

  const derived = loadInstalledPluginIndexWithDiscovery({
    ...params,
    ...(params.filePath && !params.pluginIndexFilePath
      ? { pluginIndexFilePath: params.filePath }
      : {}),
  });
  const comparePackageJsonPath =
    params.candidates !== undefined || params.discovery !== undefined || hasStalePluginFiles();
  const excludedMissingDisabledPlugins = new Map<string, string>();
  if (
    persistedIndex &&
    params.candidates === undefined &&
    params.discovery === undefined &&
    params.installRecords === undefined &&
    !hasStalePluginFiles() &&
    !hasMismatchedPersistedBundledRoot(persistedIndex, env)
  ) {
    const derivedPluginIds = new Set(derived.index.plugins.map((plugin) => plugin.pluginId));
    for (const plugin of persistedIndex.plugins) {
      if (!plugin.enabled && !derivedPluginIds.has(plugin.pluginId)) {
        excludedMissingDisabledPlugins.set(plugin.pluginId, plugin.rootDir);
      }
    }
  }
  const contentMatches =
    persistedIndex &&
    diagnostics.length === 0 &&
    isDeepStrictEqual(
      resolvePluginRegistryContent(
        persistedIndex,
        comparePackageJsonPath,
        excludedMissingDisabledPlugins,
      ),
      resolvePluginRegistryContent(
        derived.index,
        comparePackageJsonPath,
        excludedMissingDisabledPlugins,
      ),
    );
  if (persistedIndex && contentMatches) {
    const packageMetadataMatches = isDeepStrictEqual(
      resolvePluginRegistryContent(persistedIndex, true),
      resolvePluginRegistryContent(derived.index, true),
    );
    return {
      snapshot: persistedIndex,
      source: "persisted",
      diagnostics,
      discovery: derived.discovery,
      ...(packageMetadataMatches ? { manifestRegistry: derived.manifestRegistry } : {}),
    };
  } else if (persistedIndex && diagnostics.length === 0) {
    diagnostics.push({
      level: "warn",
      code: "persisted-registry-stale-source",
      message:
        "Persisted plugin registry no longer matches current plugin discovery or metadata; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
    });
  }

  return {
    snapshot: derived.index,
    source: "derived",
    diagnostics,
    discovery: derived.discovery,
    manifestRegistry: derived.manifestRegistry,
  };
}

function resolveSnapshot(params: LoadPluginRegistryParams = {}): PluginRegistrySnapshot {
  return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}

export function loadPluginRegistrySnapshot(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshot {
  return resolveSnapshot(params);
}

export function getPluginRecord(params: GetPluginRecordParams): PluginRegistryRecord | undefined {
  return getInstalledPluginRecord(resolveSnapshot(params), params.pluginId);
}

export function isPluginEnabled(params: GetPluginRecordParams): boolean {
  return isInstalledPluginEnabled(resolveSnapshot(params), params.pluginId, params.config);
}

export function inspectPluginRegistry(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<PluginRegistryInspection> {
  return inspectPersistedInstalledPluginIndex(params);
}

export function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<PluginRegistrySnapshot> {
  if (!params.config) {
    return refreshPersistedInstalledPluginIndex(params);
  }
  const workspace = resolvePluginControlPlaneWorkspace({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
  });
  const refreshParams = {
    ...params,
    diagnostics: appendPluginControlPlaneWorkspaceDiagnostic(params.diagnostics ?? [], workspace),
    ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
  };
  return refreshPersistedInstalledPluginIndex(refreshParams);
}
