import fs from "node:fs";
import path from "node:path";
import { resolveCompatibilityHostVersion } from "../version.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  refreshPersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  getInstalledPluginRecord,
  extractPluginInstallRecordsFromInstalledPluginIndex,
  isInstalledPluginEnabled,
  listInstalledPluginRecords,
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { resolvePluginCacheInputs } from "./roots.js";

export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode =
  | "persisted-registry-disabled"
  | "persisted-registry-missing"
  | "persisted-registry-stale-policy"
  | "persisted-registry-stale-source";

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code: PluginRegistrySnapshotDiagnosticCode;
  message: string;
};

export type PluginRegistrySnapshotResult = {
  snapshot: PluginRegistrySnapshot;
  source: PluginRegistrySnapshotSource;
  diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};

const DERIVED_SNAPSHOT_CACHE_MS = 1000;
const derivedSnapshotCache = new Map<
  string,
  { expiresAt: number; result: PluginRegistrySnapshotResult }
>();

export function clearPluginRegistrySnapshotCache(): void {
  derivedSnapshotCache.clear();
}

export const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";

function formatDeprecatedPersistedRegistryDisableWarning(): string {
  return `${DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV} is a deprecated break-glass compatibility switch; use \`openclaw plugins registry --refresh\` or \`openclaw doctor --fix\` to repair registry state.`;
}

export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
  };

export type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
};

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}

function hasMissingPersistedPluginSource(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!plugin.enabled) {
      return false;
    }
    return (
      !fs.existsSync(plugin.rootDir) ||
      !fs.existsSync(plugin.manifestPath) ||
      (plugin.source ? !fs.existsSync(plugin.source) : false) ||
      (plugin.setupSource ? !fs.existsSync(plugin.setupSource) : false)
    );
  });
}

function resolveComparablePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relative = path.relative(
    resolveComparablePath(parentPath),
    resolveComparablePath(childPath),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasMismatchedPersistedBundledPluginRoot(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): boolean {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return false;
  }
  return index.plugins.some(
    (plugin) =>
      plugin.origin === "bundled" && !isPathInsideOrEqual(plugin.rootDir, bundledPluginsDir),
  );
}

function resolveDerivedSnapshotCacheKey(
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): string | null {
  if (
    params.cache === false ||
    params.preferPersisted === false ||
    params.pluginIndexFilePath ||
    params.installRecords ||
    params.candidates ||
    params.diagnostics ||
    params.now
  ) {
    return null;
  }

  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: normalizedPlugins.loadPaths,
    env,
  });
  return JSON.stringify({
    persistedStore: resolveInstalledPluginIndexStorePath(params),
    roots,
    loadPaths,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    hostContractVersion: resolveCompatibilityHostVersion(env),
    disablePersisted: env[DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV] ?? "",
    disableBundled: env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ?? "",
    vitest: env.VITEST ?? "",
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

  const env = params.env ?? process.env;
  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  const disabledByCaller = params.preferPersisted === false;
  const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
  const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
  const persistedInstallRecordReadsEnabled = !disabledByEnv;
  const derivedCacheKey = persistedReadsEnabled
    ? resolveDerivedSnapshotCacheKey(params, env)
    : null;
  if (derivedCacheKey) {
    const cached = derivedSnapshotCache.get(derivedCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }
  let persistedIndex: InstalledPluginIndex | null = null;
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
      } else {
        return {
          snapshot: persistedIndex,
          source: "persisted",
          diagnostics,
        };
      }
    } else if (persistedReadsEnabled) {
      diagnostics.push({
        level: "info",
        code: "persisted-registry-missing",
        message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
      });
    }
  } else {
    diagnostics.push({
      level: "warn",
      code: "persisted-registry-disabled",
      message: disabledByEnv
        ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.`
        : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
    });
  }

  const result: PluginRegistrySnapshotResult = {
    snapshot: loadInstalledPluginIndex({
      ...params,
      installRecords:
        params.installRecords ??
        extractPluginInstallRecordsFromInstalledPluginIndex(persistedIndex),
    }),
    source: "derived",
    diagnostics,
  };
  if (derivedCacheKey) {
    derivedSnapshotCache.set(derivedCacheKey, {
      expiresAt: Date.now() + DERIVED_SNAPSHOT_CACHE_MS,
      result,
    });
  }
  return result;
}

function resolveSnapshot(params: LoadPluginRegistryParams = {}): PluginRegistrySnapshot {
  return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}

export function loadPluginRegistrySnapshot(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshot {
  return resolveSnapshot(params);
}

export function listPluginRecords(
  params: LoadPluginRegistryParams = {},
): readonly PluginRegistryRecord[] {
  return listInstalledPluginRecords(resolveSnapshot(params));
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
