// Builds stable snapshots of plugin registry contributions.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { buildLegacyBundledRootPath } from "./bundled-load-path-aliases.js";
import { listBundledSourceOverlayDirs } from "./bundled-source-overlays.js";
import { normalizePluginsConfig } from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { discoverConfiguredPluginLoadPaths, type PluginDiscoveryResult } from "./discovery.js";
import { fileSignatureMatches, hashJson } from "./installed-plugin-index-hash.js";
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
  getInstalledPluginRecord,
  extractPluginInstallRecordsFromInstalledPluginIndex,
  hasMissingConfigPathActivationMetadata,
  isInstalledPluginEnabled,
  loadInstalledPluginIndexWithDiscovery,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { getPackageManifestMetadata, type PackageManifest } from "./manifest.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import type { PluginRegistrySnapshotSource } from "./plugin-registry-snapshot.types.js";
import { fileFingerprint } from "./plugin-snapshot-fingerprint.js";
import { resolvePluginCacheInputs } from "./roots.js";

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
};

const MAX_PLUGIN_REGISTRY_SNAPSHOT_MEMOS = 8;
const REGISTRY_SNAPSHOT_MEMO_ENV_KEYS = [
  "APPDATA",
  "HOME",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_COMPATIBILITY_HOST_VERSION",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS",
  "OPENCLAW_HOME",
  "OPENCLAW_NIX_MODE",
  "OPENCLAW_STATE_DIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const;

type PluginRegistrySnapshotMemo = {
  key: string;
  result: PluginRegistrySnapshotResult;
};

let pluginRegistrySnapshotMemos: PluginRegistrySnapshotMemo[] = [];

function clearLoadPluginRegistrySnapshotMemo(): void {
  pluginRegistrySnapshotMemos = [];
}

registerPluginMetadataProcessMemoLifecycleClear(clearLoadPluginRegistrySnapshotMemo);

export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
  };

type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
};

function pickRegistrySnapshotMemoEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    REGISTRY_SNAPSHOT_MEMO_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function canMemoizePluginRegistrySnapshot(params: LoadPluginRegistryParams): boolean {
  return (
    params.index === undefined &&
    params.candidates === undefined &&
    params.diagnostics === undefined &&
    params.discovery === undefined &&
    params.installRecords === undefined &&
    params.now === undefined &&
    params.filePath === undefined &&
    params.pluginIndexFilePath === undefined
  );
}

function resolvePluginRegistrySnapshotMemoKey(
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!canMemoizePluginRegistrySnapshot(params)) {
    return undefined;
  }
  const persistedReadsEnabled = params.preferPersisted !== false;
  const persistedRegistryFingerprint = persistedReadsEnabled
    ? hashJson(
        readPersistedInstalledPluginIndexSync({
          env,
          ...(params.stateDir ? { stateDir: params.stateDir } : {}),
        }),
      )
    : "disabled";
  return hashJson({
    config: params.config ?? null,
    cwd: process.cwd(),
    env: pickRegistrySnapshotMemoEnv(env),
    hostContractVersion: resolveCompatibilityHostVersion(env),
    preferPersisted: params.preferPersisted ?? null,
    // Plugin manifests are process-stable inside the Gateway, while the persisted
    // registry envelope can change through explicit refresh/install flows.
    registry: persistedRegistryFingerprint,
    pluginRoots: fingerprintPluginSourceRoots(params, env),
    stateDir: params.stateDir ? resolveUserPath(params.stateDir, env) : null,
    workspaceDir: params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : null,
  });
}

function fingerprintPluginSourceRoots(
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): unknown {
  const workspaceDir = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
  const cacheInputs = resolvePluginCacheInputs({
    workspaceDir,
    loadPaths: normalizePluginsConfig(params.config?.plugins).loadPaths,
    env,
  });
  return {
    global: sourceRootFingerprint(cacheInputs.roots.global),
    loadPaths: cacheInputs.loadPaths.map((entry) => sourceRootFingerprint(entry)),
    stock: cacheInputs.roots.stock ? sourceRootFingerprint(cacheInputs.roots.stock) : null,
    workspace: cacheInputs.roots.workspace
      ? sourceRootFingerprint(cacheInputs.roots.workspace)
      : null,
  };
}

function sourceRootFingerprint(rootPath: string): unknown {
  return {
    root: fileFingerprint(rootPath),
    // Directory mtimes can be too coarse on some Linux filesystems. Include only
    // immediate child names/kinds so same-tick plugin installs invalidate the
    // process memo without rereading manifests on hot registry lookups.
    children: directoryChildFingerprint(rootPath),
  };
}

function directoryChildFingerprint(directoryPath: string): unknown {
  try {
    return fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .map((entry) => [entry.name, entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"])
      .toSorted(([left], [right]) =>
        expectDefined(left, "plugin registry snapshot left").localeCompare(
          expectDefined(right, "plugin registry snapshot right"),
        ),
      );
  } catch {
    return "unreadable";
  }
}

function findPluginRegistrySnapshotMemo(
  key: string | undefined,
): PluginRegistrySnapshotResult | undefined {
  if (!key) {
    return undefined;
  }
  const index = pluginRegistrySnapshotMemos.findIndex((memo) => memo.key === key);
  if (index === -1) {
    return undefined;
  }
  const [memo] = pluginRegistrySnapshotMemos.splice(index, 1);
  if (!memo) {
    return undefined;
  }
  pluginRegistrySnapshotMemos.unshift(memo);
  return memo.result;
}

function rememberPluginRegistrySnapshotMemo(
  key: string | undefined,
  result: PluginRegistrySnapshotResult,
): PluginRegistrySnapshotResult {
  if (!key) {
    return result;
  }
  pluginRegistrySnapshotMemos = [
    { key, result },
    ...pluginRegistrySnapshotMemos.filter((memo) => memo.key !== key),
  ].slice(0, MAX_PLUGIN_REGISTRY_SNAPSHOT_MEMOS);
  return result;
}

function canReuseCurrentPluginMetadataSnapshot(params: LoadPluginRegistryParams): boolean {
  return (
    params.preferPersisted !== false &&
    params.stateDir === undefined &&
    params.filePath === undefined &&
    params.pluginIndexFilePath === undefined &&
    params.installRecords === undefined &&
    params.candidates === undefined &&
    params.diagnostics === undefined &&
    params.now === undefined
  );
}

function loadCurrentPluginRegistrySnapshotResult(
  params: LoadPluginRegistryParams,
): PluginRegistrySnapshotResult | undefined {
  if (!canReuseCurrentPluginMetadataSnapshot(params)) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
  });
  if (!current || current.registryDiagnostics.length > 0) {
    return undefined;
  }
  return {
    snapshot: current.index,
    source: "provided",
    diagnostics: current.registryDiagnostics,
  };
}

function hasMissingPersistedPluginSource(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!plugin.enabled) {
      return false;
    }
    return (
      !fs.existsSync(plugin.rootDir) ||
      (!hasOptionalMissingPluginManifestFile(plugin) && !fs.existsSync(plugin.manifestPath)) ||
      (plugin.source ? !fs.existsSync(plugin.source) : false) ||
      (plugin.setupSource ? !fs.existsSync(plugin.setupSource) : false)
    );
  });
}

function hasMismatchedPersistedConfigPathPlugins(
  index: InstalledPluginIndex,
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): boolean {
  const loadPaths = normalizePluginsConfig(params.config?.plugins).loadPaths;
  const discovery = discoverConfiguredPluginLoadPaths({
    loadPaths,
    workspaceDir: params.workspaceDir,
    env,
  });
  const configuredRoots = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(index),
  }).plugins.map((plugin) => resolveComparablePath(plugin.rootDir));
  const persistedRoots = index.plugins
    .filter((plugin) => plugin.origin === "config")
    .map((plugin) => resolveComparablePath(plugin.rootDir));
  if (configuredRoots.length !== persistedRoots.length) {
    return true;
  }
  return configuredRoots.some((rootDir, position) => rootDir !== persistedRoots[position]);
}

function resolveComparablePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relative = path.relative(
    resolveComparablePath(parentPath),
    resolveComparablePath(childPath),
  );
  return isRelativePathInsideOrEqual(relative);
}

function hasMismatchedPersistedBundledPluginRoot(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): boolean {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return false;
  }
  let sourceOverlayDirs: string[] | undefined;
  return index.plugins.some((plugin) => {
    if (plugin.origin !== "bundled") {
      return false;
    }
    sourceOverlayDirs ??= listBundledSourceOverlayDirs({
      bundledRoot: bundledPluginsDir,
      env,
    });
    return !isAllowedPersistedBundledPluginRoot(plugin, bundledPluginsDir, sourceOverlayDirs);
  });
}

function isAllowedPersistedBundledPluginRoot(
  plugin: InstalledPluginIndexRecord,
  bundledPluginsDir: string,
  sourceOverlayDirs: readonly string[],
): boolean {
  const pluginRootDir = plugin.rootDir;
  const legacyRoot = buildLegacyBundledRootPath(bundledPluginsDir);
  if (isPathInsideOrEqual(pluginRootDir, bundledPluginsDir)) {
    if (!legacyRoot || !isSourceCheckoutBundledPluginRoot(legacyRoot)) {
      return true;
    }
    const relativePluginRoot = path.relative(
      resolveComparablePath(bundledPluginsDir),
      resolveComparablePath(pluginRootDir),
    );
    return !sourcePluginOptsOutOfBundledDist(path.join(legacyRoot, relativePluginRoot));
  }
  if (sourceOverlayDirs.some((overlayDir) => isPathInsideOrEqual(pluginRootDir, overlayDir))) {
    return true;
  }
  if (!legacyRoot || !isSourceCheckoutBundledPluginRoot(legacyRoot)) {
    return false;
  }
  const relativePluginRoot = path.relative(
    resolveComparablePath(legacyRoot),
    resolveComparablePath(pluginRootDir),
  );
  if (!isRelativePathInsideOrEqual(relativePluginRoot)) {
    return false;
  }
  if (plugin.packageBuild?.bundledDist === false) {
    return true;
  }
  if (sourcePluginOptsOutOfBundledDist(path.join(legacyRoot, relativePluginRoot))) {
    // Older index records lack packageBuild. Re-derive once so runtime loading
    // and OpenClaw fingerprint the same source-only artifact.
    return false;
  }
  // Discovery prefers a built plugin whenever the same child exists in the
  // packaged root. Keep source-only bundled plugins, but invalidate stale
  // source records once their built peer appears.
  return !fs.existsSync(path.join(bundledPluginsDir, relativePluginRoot));
}

function sourcePluginOptsOutOfBundledDist(pluginRootDir: string): boolean {
  const packageJson = tryReadJsonSync<PackageManifest>(path.join(pluginRootDir, "package.json"));
  return getPackageManifestMetadata(packageJson ?? undefined)?.build?.bundledDist === false;
}

function isSourceCheckoutBundledPluginRoot(extensionsDir: string): boolean {
  const packageRoot = path.dirname(extensionsDir);
  return (
    fs.existsSync(extensionsDir) &&
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(packageRoot, "src"))
  );
}

function hashExistingFile(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function resolveRecordPackageJsonPath(plugin: InstalledPluginIndexRecord): string | null {
  const packageJsonPath = plugin.packageJson?.path;
  if (!packageJsonPath) {
    return null;
  }
  const rootDir = plugin.rootDir || path.dirname(plugin.manifestPath);
  const resolved = path.resolve(rootDir, packageJsonPath);
  const relative = path.relative(rootDir, resolved);
  if (!isRelativePathInsideOrEqual(relative)) {
    return null;
  }
  const realRelative = path.relative(
    resolveComparablePath(rootDir),
    resolveComparablePath(resolved),
  );
  return isRelativePathInsideOrEqual(realRelative) ? resolved : null;
}

function hasStalePersistedPluginDiagnostics(index: InstalledPluginIndex): boolean {
  return index.diagnostics.some((diag) => {
    const source = diag.source;
    return (
      typeof diag.pluginId === "string" &&
      diag.pluginId.trim().length > 0 &&
      typeof source === "string" &&
      path.isAbsolute(source) &&
      !fs.existsSync(source)
    );
  });
}

function hasStalePersistedPluginMetadata(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!hasOptionalMissingPluginManifestFile(plugin)) {
      const manifestSignatureMatches = fileSignatureMatches(
        plugin.manifestPath,
        plugin.manifestFile,
      );
      if (manifestSignatureMatches !== true) {
        const manifestHash = hashExistingFile(plugin.manifestPath);
        if (manifestHash && manifestHash !== plugin.manifestHash) {
          return true;
        }
      }
    }
    const packageJsonPath = resolveRecordPackageJsonPath(plugin);
    if (!plugin.packageJson?.hash) {
      return false;
    }
    if (!packageJsonPath) {
      return true;
    }
    const packageJsonSignatureMatches = fileSignatureMatches(
      packageJsonPath,
      plugin.packageJson.fileSignature,
    );
    if (packageJsonSignatureMatches === true && plugin.origin === "bundled") {
      return false;
    }
    if (packageJsonSignatureMatches === false) {
      return hashExistingFile(packageJsonPath) !== plugin.packageJson.hash;
    }
    // Fast same-size rewrites can preserve observable stat fields on some filesystems.
    const packageJsonHash = hashExistingFile(packageJsonPath);
    return packageJsonHash !== plugin.packageJson.hash;
  });
}

function loadSnapshotInstallRecords(params: LoadPluginRegistryParams, env: NodeJS.ProcessEnv) {
  return loadInstalledPluginIndexInstallRecordsSync({
    env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.filePath
      ? { filePath: params.filePath }
      : params.pluginIndexFilePath
        ? { filePath: params.pluginIndexFilePath }
        : {}),
  });
}

function hasRecoveredInstallRecordsMissingFromPersistedIndex(
  index: InstalledPluginIndex,
  installRecords: ReturnType<typeof loadInstalledPluginIndexInstallRecordsSync>,
  env: NodeJS.ProcessEnv,
): boolean {
  const persistedRecords = extractPluginInstallRecordsFromInstalledPluginIndex(index);
  const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
  return Object.entries(installRecords).some(([pluginId, record]) => {
    if (persistedRecords[pluginId] && persistedPluginIds.has(pluginId)) {
      return false;
    }
    const installPaths = [record.installPath, record.sourcePath].filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
    if (installPaths.length === 0) {
      return true;
    }
    return installPaths.some((installPath) => fs.existsSync(resolveUserPath(installPath, env)));
  });
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
  const memoKey = resolvePluginRegistrySnapshotMemoKey(params, env);
  const memo = findPluginRegistrySnapshotMemo(memoKey);
  if (memo) {
    return memo;
  }
  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  const disabledByCaller = params.preferPersisted === false;
  const persistedReadsEnabled = !disabledByCaller;
  const persistedInstallRecordReadsEnabled = persistedReadsEnabled;
  let persistedIndex: InstalledPluginIndex | null;
  if (persistedInstallRecordReadsEnabled) {
    persistedIndex = readPersistedInstalledPluginIndexSync(params);
    if (persistedReadsEnabled && persistedIndex) {
      if (
        params.config &&
        persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-policy",
          message:
            "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMissingPersistedPluginSource(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry points at missing plugin files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMismatchedPersistedBundledPluginRoot(persistedIndex, env)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry points at a different bundled plugin tree; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMismatchedPersistedConfigPathPlugins(persistedIndex, params, env)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry does not match configured load-path plugins; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasStalePersistedPluginDiagnostics(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry contains diagnostics referencing missing paths; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMissingConfigPathActivationMetadata(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry is missing config-path startup metadata; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasStalePersistedPluginMetadata(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry metadata no longer matches plugin manifest or package files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (
        hasRecoveredInstallRecordsMissingFromPersistedIndex(
          persistedIndex,
          loadSnapshotInstallRecords(params, env),
          env,
        )
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry is missing recoverable managed npm plugins; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else {
        const persistedResult: PluginRegistrySnapshotResult = {
          snapshot: persistedIndex,
          source: "persisted",
          diagnostics,
        };
        return rememberPluginRegistrySnapshotMemo(memoKey, persistedResult);
      }
    } else if (persistedReadsEnabled) {
      diagnostics.push({
        level: "info",
        code: "persisted-registry-missing",
        message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
      });
    }
  }

  const derived = loadInstalledPluginIndexWithDiscovery({
    ...params,
    installRecords: persistedInstallRecordReadsEnabled
      ? params.installRecords
      : (params.installRecords ?? {}),
  });
  return rememberPluginRegistrySnapshotMemo(memoKey, {
    snapshot: derived.index,
    source: "derived",
    diagnostics,
    discovery: derived.discovery,
  });
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
  return refreshPersistedInstalledPluginIndex(params);
}
