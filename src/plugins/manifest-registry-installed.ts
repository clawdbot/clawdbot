/** Builds manifest registry records from installed plugin index snapshots. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import type { PluginCandidate } from "./discovery.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import type { InstalledPluginFileSignature } from "./installed-plugin-index-hash.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type { BundledChannelConfigCollector } from "./manifest-registry.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  normalizeManifestChannelCommandDefaults,
  type OpenClawPackageManifest,
  type PackageManifest,
  type PluginPackageChannel,
} from "./manifest.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  normalizePluginDependencySpecs,
  type PluginDependencySpecMap,
} from "./status-dependencies-core.js";

const installedManifestRegistryIndexFingerprintCache = new WeakMap<InstalledPluginIndex, string>();
const installedPackageJsonPathCache = new Map<string, string | null>();
const installedPackageMetadataCache = new Map<string, InstalledPackageMetadata>();
// Installed plugin metadata is process-stable between explicit lifecycle clears.
// Share realpaths across fingerprint builds to avoid repeated package boundary IO.
const installedManifestRegistryRealpathCache = new Map<string, string>();
const MAX_INSTALLED_PACKAGE_JSON_PATH_CACHE_ENTRIES = 256;
const MAX_INSTALLED_PACKAGE_METADATA_CACHE_ENTRIES = 256;
const MAX_INSTALLED_MANIFEST_REGISTRY_REALPATH_CACHE_ENTRIES = 512;

type InstalledPackageMetadata = {
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
};

function clearInstalledManifestRegistryProcessCaches(): void {
  installedPackageJsonPathCache.clear();
  installedPackageMetadataCache.clear();
  installedManifestRegistryRealpathCache.clear();
}

registerPluginMetadataProcessMemoLifecycleClear(clearInstalledManifestRegistryProcessCaches);

function isDeepFrozenJsonLike(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") {
    return true;
  }
  const object = value;
  if (seen.has(object)) {
    return true;
  }
  if (!Object.isFrozen(object)) {
    return false;
  }
  seen.add(object);
  return Object.values(value).every((entry) => isDeepFrozenJsonLike(entry, seen));
}

function hasPersistedFileSignatures(index: InstalledPluginIndex): boolean {
  return index.plugins.every(
    (record) =>
      record.manifestFile !== undefined &&
      (record.packageJson === undefined || record.packageJson.fileSignature !== undefined),
  );
}

function isInstalledManifestRegistryIndexFingerprintCacheable(
  index: InstalledPluginIndex,
): boolean {
  return hasPersistedFileSignatures(index) && isDeepFrozenJsonLike(index);
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function resolvePackageJsonPath(
  record: InstalledPluginIndexRecord,
  realpathCache: Map<string, string>,
): string | undefined {
  if (!record.packageJson?.path) {
    return undefined;
  }
  const cacheKey = buildInstalledPackageJsonPathCacheKey(record);
  if (cacheKey) {
    const cached = installedPackageJsonPathCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
  }
  const rootDir = resolveInstalledPluginRootDir(record);
  const realRootDir = safeRealpathSync(rootDir, realpathCache) ?? path.resolve(rootDir);
  const packageJsonPath = path.resolve(realRootDir, record.packageJson.path);
  const relative = path.relative(realRootDir, packageJsonPath);
  if (!isRelativePathInsideOrEqual(relative)) {
    return rememberInstalledPackageJsonPath(cacheKey, undefined);
  }
  const packageJsonRealPath = safeRealpathSync(packageJsonPath, realpathCache);
  if (!packageJsonRealPath || !isPathInside(realRootDir, packageJsonRealPath)) {
    return rememberInstalledPackageJsonPath(cacheKey, undefined);
  }
  return rememberInstalledPackageJsonPath(cacheKey, packageJsonPath);
}

function safeFileSignature(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    const stat = fs.statSync(filePath);
    return formatFileSignature(filePath, stat);
  } catch {
    return `${filePath}:missing`;
  }
}

function formatFileSignature(
  filePath: string,
  signature: Pick<InstalledPluginFileSignature, "size" | "mtimeMs">,
): string {
  return `${filePath}:${signature.size}:${signature.mtimeMs}`;
}

function rememberInstalledPackageMetadata(
  key: string | undefined,
  metadata: InstalledPackageMetadata,
): InstalledPackageMetadata {
  if (!key) {
    return metadata;
  }
  installedPackageMetadataCache.set(key, metadata);
  while (installedPackageMetadataCache.size > MAX_INSTALLED_PACKAGE_METADATA_CACHE_ENTRIES) {
    const oldest = installedPackageMetadataCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    installedPackageMetadataCache.delete(oldest);
  }
  return metadata;
}

function rememberInstalledPackageJsonPath(
  key: string | undefined,
  packageJsonPath: string | undefined,
): string | undefined {
  if (!key) {
    return packageJsonPath;
  }
  installedPackageJsonPathCache.set(key, packageJsonPath ?? null);
  while (installedPackageJsonPathCache.size > MAX_INSTALLED_PACKAGE_JSON_PATH_CACHE_ENTRIES) {
    const oldest = installedPackageJsonPathCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    installedPackageJsonPathCache.delete(oldest);
  }
  return packageJsonPath;
}

function trimInstalledManifestRegistryRealpathCache(): void {
  while (
    installedManifestRegistryRealpathCache.size >
    MAX_INSTALLED_MANIFEST_REGISTRY_REALPATH_CACHE_ENTRIES
  ) {
    const oldest = installedManifestRegistryRealpathCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    installedManifestRegistryRealpathCache.delete(oldest);
  }
}

function buildInstalledPackageJsonPathCacheKey(
  record: InstalledPluginIndexRecord,
): string | undefined {
  if (!record.packageJson?.path || !record.packageJson.hash) {
    return undefined;
  }
  return hashJson({
    rootDir: path.resolve(resolveInstalledPluginRootDir(record)),
    packageJson: record.packageJson,
  });
}

function buildInstalledPackageMetadataCacheKey(params: {
  packageJsonPath?: string;
  record: InstalledPluginIndexRecord;
}): string | undefined {
  if (!params.packageJsonPath || !params.record.packageJson?.hash) {
    return undefined;
  }
  return hashJson({
    packageJsonPath: path.resolve(params.packageJsonPath),
    packageJson: params.record.packageJson,
    packageChannel: params.record.packageChannel ?? null,
  });
}

function buildInstalledManifestRegistryIndexKey(index: InstalledPluginIndex) {
  return {
    version: index.version,
    hostContractVersion: index.hostContractVersion,
    compatRegistryVersion: index.compatRegistryVersion,
    migrationVersion: index.migrationVersion,
    policyHash: index.policyHash,
    installRecords: index.installRecords,
    diagnostics: index.diagnostics,
    plugins: index.plugins.map((record) => {
      const packageJsonPath = resolvePackageJsonPath(
        record,
        installedManifestRegistryRealpathCache,
      );
      trimInstalledManifestRegistryRealpathCache();
      const packageJsonFile = record.packageJson?.fileSignature
        ? packageJsonPath
          ? formatFileSignature(packageJsonPath, record.packageJson.fileSignature)
          : undefined
        : safeFileSignature(packageJsonPath);
      return {
        pluginId: record.pluginId,
        packageName: record.packageName,
        packageVersion: record.packageVersion,
        installRecord: record.installRecord,
        installRecordHash: record.installRecordHash,
        packageInstall: record.packageInstall,
        packageChannel: record.packageChannel,
        manifestPath: record.manifestPath,
        manifestHash: record.manifestHash,
        manifestFile: record.manifestFile
          ? formatFileSignature(record.manifestPath, record.manifestFile)
          : safeFileSignature(record.manifestPath),
        format: record.format,
        bundleFormat: record.bundleFormat,
        source: record.source,
        setupSource: record.setupSource,
        packageJson: record.packageJson,
        packageJsonFile,
        rootDir: record.rootDir,
        origin: record.origin,
        enabled: record.enabled,
        enabledByDefault: record.enabledByDefault,
        enabledByDefaultOnPlatforms: record.enabledByDefaultOnPlatforms
          ? [...record.enabledByDefaultOnPlatforms]
          : undefined,
        syntheticAuthRefs: record.syntheticAuthRefs,
        startup: record.startup,
        compat: record.compat,
      };
    }),
  };
}

export function resolveInstalledManifestRegistryIndexFingerprint(
  index: InstalledPluginIndex,
): string {
  const cached = installedManifestRegistryIndexFingerprintCache.get(index);
  if (cached) {
    return cached;
  }
  const fingerprint = hashJson(buildInstalledManifestRegistryIndexKey(index));
  if (isInstalledManifestRegistryIndexFingerprintCacheable(index)) {
    installedManifestRegistryIndexFingerprintCache.set(index, fingerprint);
  }
  return fingerprint;
}

function resolveInstalledPluginRootDir(record: InstalledPluginIndexRecord): string {
  return record.rootDir || path.dirname(record.manifestPath || process.cwd());
}

function resolveFallbackPluginSource(record: InstalledPluginIndexRecord): string {
  const rootDir = resolveInstalledPluginRootDir(record);
  for (const entry of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
    const candidate = path.join(rootDir, entry);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(rootDir, DEFAULT_PLUGIN_ENTRY_CANDIDATES[0]);
}

function normalizePackageChannelExposure(
  exposure: unknown,
): PluginPackageChannel["exposure"] | undefined {
  if (!isRecord(exposure)) {
    return undefined;
  }
  const configured = typeof exposure.configured === "boolean" ? exposure.configured : undefined;
  const setup = typeof exposure.setup === "boolean" ? exposure.setup : undefined;
  const docs = typeof exposure.docs === "boolean" ? exposure.docs : undefined;
  return configured !== undefined || setup !== undefined || docs !== undefined
    ? {
        ...(configured !== undefined ? { configured } : {}),
        ...(setup !== undefined ? { setup } : {}),
        ...(docs !== undefined ? { docs } : {}),
      }
    : undefined;
}

function normalizePackageChannelConfiguredState(
  configuredState: unknown,
): PluginPackageChannel["configuredState"] | undefined {
  if (!isRecord(configuredState)) {
    return undefined;
  }
  const env = isRecord(configuredState.env)
    ? {
        ...(normalizeOptionalTrimmedStringList(configuredState.env.allOf)?.length
          ? { allOf: normalizeOptionalTrimmedStringList(configuredState.env.allOf) }
          : {}),
        ...(normalizeOptionalTrimmedStringList(configuredState.env.anyOf)?.length
          ? { anyOf: normalizeOptionalTrimmedStringList(configuredState.env.anyOf) }
          : {}),
      }
    : undefined;
  const specifier = normalizeOptionalString(configuredState.specifier);
  const exportName = normalizeOptionalString(configuredState.exportName);
  return specifier || exportName || (env && Object.keys(env).length > 0)
    ? {
        ...(specifier ? { specifier } : {}),
        ...(exportName ? { exportName } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      }
    : undefined;
}

function normalizePackageChannelPersistedAuthState(
  persistedAuthState: unknown,
): PluginPackageChannel["persistedAuthState"] | undefined {
  if (!isRecord(persistedAuthState)) {
    return undefined;
  }
  const specifier = normalizeOptionalString(persistedAuthState.specifier);
  const exportName = normalizeOptionalString(persistedAuthState.exportName);
  return specifier || exportName
    ? {
        ...(specifier ? { specifier } : {}),
        ...(exportName ? { exportName } : {}),
      }
    : undefined;
}

function normalizePackageChannelDoctorCapabilities(
  doctorCapabilities: unknown,
): PluginPackageChannel["doctorCapabilities"] | undefined {
  if (!isRecord(doctorCapabilities)) {
    return undefined;
  }
  const dmAllowFromMode =
    doctorCapabilities.dmAllowFromMode === "topOnly" ||
    doctorCapabilities.dmAllowFromMode === "topOrNested" ||
    doctorCapabilities.dmAllowFromMode === "nestedOnly"
      ? doctorCapabilities.dmAllowFromMode
      : undefined;
  const groupModel =
    doctorCapabilities.groupModel === "sender" ||
    doctorCapabilities.groupModel === "route" ||
    doctorCapabilities.groupModel === "hybrid"
      ? doctorCapabilities.groupModel
      : undefined;
  const groupAllowFromFallbackToAllowFrom =
    typeof doctorCapabilities.groupAllowFromFallbackToAllowFrom === "boolean"
      ? doctorCapabilities.groupAllowFromFallbackToAllowFrom
      : undefined;
  const warnOnEmptyGroupSenderAllowlist =
    typeof doctorCapabilities.warnOnEmptyGroupSenderAllowlist === "boolean"
      ? doctorCapabilities.warnOnEmptyGroupSenderAllowlist
      : undefined;
  return dmAllowFromMode ||
    groupModel ||
    groupAllowFromFallbackToAllowFrom !== undefined ||
    warnOnEmptyGroupSenderAllowlist !== undefined
    ? {
        ...(dmAllowFromMode ? { dmAllowFromMode } : {}),
        ...(groupModel ? { groupModel } : {}),
        ...(groupAllowFromFallbackToAllowFrom !== undefined
          ? { groupAllowFromFallbackToAllowFrom }
          : {}),
        ...(warnOnEmptyGroupSenderAllowlist !== undefined
          ? { warnOnEmptyGroupSenderAllowlist }
          : {}),
      }
    : undefined;
}

function normalizePackageChannelCliOptions(
  cliAddOptions: unknown,
): PluginPackageChannel["cliAddOptions"] | undefined {
  if (!Array.isArray(cliAddOptions)) {
    return undefined;
  }
  const normalized = cliAddOptions.flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const flags = normalizeOptionalString(option.flags);
    const description = normalizeOptionalString(option.description);
    if (!flags || !description) {
      return [];
    }
    const defaultValue =
      typeof option.defaultValue === "boolean" || typeof option.defaultValue === "string"
        ? option.defaultValue
        : undefined;
    return [
      {
        flags,
        description,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      },
    ];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePersistedPackageChannel(value: unknown): PluginPackageChannel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id);
  if (!id) {
    return undefined;
  }
  const channel: PluginPackageChannel = { id };
  for (const key of [
    "label",
    "selectionLabel",
    "detailLabel",
    "docsPath",
    "docsLabel",
    "blurb",
    "systemImage",
    "selectionDocsPrefix",
  ] as const) {
    const normalized = normalizeOptionalString(value[key]);
    if (normalized) {
      channel[key] = normalized;
    }
  }
  if (typeof value.order === "number" && Number.isFinite(value.order)) {
    channel.order = value.order;
  }
  for (const key of ["aliases", "preferOver", "selectionExtras"] as const) {
    const normalized = normalizeOptionalTrimmedStringList(value[key]);
    if (normalized?.length) {
      channel[key] = normalized;
    }
  }
  for (const key of [
    "selectionDocsOmitLabel",
    "markdownCapable",
    "quickstartAllowFrom",
    "forceAccountBinding",
    "preferSessionLookupForAnnounceTarget",
  ] as const) {
    if (typeof value[key] === "boolean") {
      channel[key] = value[key];
    }
  }
  const exposure = normalizePackageChannelExposure(value.exposure);
  if (exposure) {
    channel.exposure = exposure;
  }
  const commands = normalizeManifestChannelCommandDefaults(value.commands);
  if (commands) {
    channel.commands = commands;
  }
  const configuredState = normalizePackageChannelConfiguredState(value.configuredState);
  if (configuredState) {
    channel.configuredState = configuredState;
  }
  const persistedAuthState = normalizePackageChannelPersistedAuthState(value.persistedAuthState);
  if (persistedAuthState) {
    channel.persistedAuthState = persistedAuthState;
  }
  const doctorCapabilities = normalizePackageChannelDoctorCapabilities(value.doctorCapabilities);
  if (doctorCapabilities) {
    channel.doctorCapabilities = doctorCapabilities;
  }
  const cliAddOptions = normalizePackageChannelCliOptions(value.cliAddOptions);
  if (cliAddOptions) {
    channel.cliAddOptions = cliAddOptions;
  }
  return channel;
}

function resolveInstalledPackageMetadata(
  record: InstalledPluginIndexRecord,
  realpathCache: Map<string, string>,
): InstalledPackageMetadata {
  const recordPackageChannel = normalizePersistedPackageChannel(record.packageChannel);
  const fallbackPackageManifest = recordPackageChannel
    ? {
        channel: recordPackageChannel,
      }
    : undefined;
  const packageJsonPath = record.packageJson?.path
    ? resolvePackageJsonPath(record, realpathCache)
    : undefined;
  const cacheKey = buildInstalledPackageMetadataCacheKey({ packageJsonPath, record });
  const cached = cacheKey ? installedPackageMetadataCache.get(cacheKey) : undefined;
  if (cached) {
    return cached;
  }
  if (!packageJsonPath) {
    return rememberInstalledPackageMetadata(
      cacheKey,
      fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {},
    );
  }
  const packageJson = tryReadJsonSync<PackageManifest>(packageJsonPath);
  if (packageJson) {
    const packageManifest = getPackageManifestMetadata(packageJson);
    const dependencies = normalizePluginDependencySpecs({
      dependencies: packageJson.dependencies,
      optionalDependencies: packageJson.optionalDependencies,
    });
    if (!packageManifest) {
      return rememberInstalledPackageMetadata(cacheKey, {
        ...(fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {}),
        packageDependencies: dependencies.dependencies,
        packageOptionalDependencies: dependencies.optionalDependencies,
      });
    }
    const packageChannel = normalizePersistedPackageChannel(packageManifest.channel);
    const channel =
      recordPackageChannel || packageChannel
        ? {
            ...recordPackageChannel,
            ...packageChannel,
          }
        : undefined;
    const { channel: _ignoredChannel, ...packageManifestWithoutChannel } = packageManifest;
    return rememberInstalledPackageMetadata(cacheKey, {
      packageManifest: {
        ...packageManifestWithoutChannel,
        ...(channel ? { channel } : {}),
      },
      packageDependencies: dependencies.dependencies,
      packageOptionalDependencies: dependencies.optionalDependencies,
    });
  }
  return rememberInstalledPackageMetadata(
    cacheKey,
    fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {},
  );
}

function toPluginCandidate(
  record: InstalledPluginIndexRecord,
  realpathCache: Map<string, string>,
): PluginCandidate {
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageMetadata = resolveInstalledPackageMetadata(record, realpathCache);
  return {
    idHint: record.pluginId,
    source: record.source ?? resolveFallbackPluginSource(record),
    ...(record.setupSource ? { setupSource: record.setupSource } : {}),
    rootDir,
    origin: record.origin,
    ...(record.format ? { format: record.format } : {}),
    ...(record.bundleFormat ? { bundleFormat: record.bundleFormat } : {}),
    ...(record.packageName ? { packageName: record.packageName } : {}),
    ...(record.packageVersion ? { packageVersion: record.packageVersion } : {}),
    ...(packageMetadata.packageManifest
      ? { packageManifest: packageMetadata.packageManifest }
      : {}),
    ...(packageMetadata.packageDependencies
      ? { packageDependencies: packageMetadata.packageDependencies }
      : {}),
    ...(packageMetadata.packageOptionalDependencies
      ? { packageOptionalDependencies: packageMetadata.packageOptionalDependencies }
      : {}),
    packageDir: rootDir,
  };
}

export function loadPluginManifestRegistryForInstalledIndex(params: {
  index: InstalledPluginIndex;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  includeDisabled?: boolean;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
}): PluginManifestRegistry {
  return tracePluginLifecyclePhase(
    "manifest registry",
    () => {
      if (params.pluginIds && params.pluginIds.length === 0) {
        return { plugins: [], diagnostics: [] };
      }
      const env = params.env ?? process.env;
      const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
      const realpathCache = new Map<string, string>();
      const diagnostics = pluginIdSet
        ? params.index.diagnostics.filter((diagnostic) => {
            const pluginId = diagnostic.pluginId;
            return !pluginId || pluginIdSet.has(pluginId);
          })
        : params.index.diagnostics;
      const candidates = params.index.plugins
        .filter((plugin) => params.includeDisabled || plugin.enabled)
        .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId))
        .map((plugin) => toPluginCandidate(plugin, realpathCache));
      return loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env,
        candidates,
        diagnostics: [...diagnostics],
        installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(params.index),
        ...(params.bundledChannelConfigCollector
          ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
          : {}),
      });
    },
    {
      includeDisabled: params.includeDisabled === true,
      pluginIdCount: params.pluginIds?.length,
      indexPluginCount: params.index.plugins.length,
    },
  );
}
