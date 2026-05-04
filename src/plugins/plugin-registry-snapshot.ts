import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { fileSignatureMatches } from "./installed-plugin-index-hash.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
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
  isInstalledPluginEnabled,
  listInstalledPluginRecords,
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";

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
      (!hasOptionalMissingPluginManifestFile(plugin) && !fs.existsSync(plugin.manifestPath)) ||
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
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : resolved;
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
      } else if (hasStalePersistedPluginMetadata(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry metadata no longer matches plugin manifest or package files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
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

  return {
    snapshot: loadInstalledPluginIndex({
      ...params,
      installRecords:
        params.installRecords ??
        extractPluginInstallRecordsFromInstalledPluginIndex(persistedIndex),
    }),
    source: "derived",
    diagnostics,
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
