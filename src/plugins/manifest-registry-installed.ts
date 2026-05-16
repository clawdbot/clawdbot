import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeOptionalTrimmedStringList } from "../shared/string-normalization.js";
import type { PluginCandidate } from "./discovery.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type { BundledChannelConfigCollector } from "./manifest-registry.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  type OpenClawPackageManifest,
  type PackageManifest,
  type PluginPackageChannel,
} from "./manifest.js";
import { isPathInsideWithRealpath, safeRealpathSync } from "./path-safety.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import {
  normalizePluginDependencySpecs,
  type PluginDependencySpecMap,
} from "./status-dependencies.js";

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function resolvePackageJsonPath(record: InstalledPluginIndexRecord): string | undefined {
  if (!record.packageJson?.path) {
    return undefined;
  }
  const rootDir = resolveInstalledPluginRootDir(record);
  const realRootDir = safeRealpathSync(rootDir) ?? path.resolve(rootDir);
  const packageJsonPath = path.resolve(realRootDir, record.packageJson.path);
  const relative = path.relative(realRootDir, packageJsonPath);
  if (!isRelativePathInsideOrEqual(relative)) {
    return undefined;
  }
  if (!isPathInsideWithRealpath(realRootDir, packageJsonPath)) {
    return undefined;
  }
  return packageJsonPath;
}

function safeFileSignature(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
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
      const packageJsonPath = resolvePackageJsonPath(record);
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
        manifestFile: safeFileSignature(record.manifestPath),
        format: record.format,
        bundleFormat: record.bundleFormat,
        source: record.source,
        setupSource: record.setupSource,
        packageJson: record.packageJson,
        packageJsonFile: safeFileSignature(packageJsonPath),
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
  return hashJson(buildInstalledManifestRegistryIndexKey(index));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePackageChannelCommands(
  commands: unknown,
): PluginPackageChannel["commands"] | undefined {
  if (!isRecord(commands)) {
    return undefined;
  }
  const nativeCommandsAutoEnabled =
    typeof commands.nativeCommandsAutoEnabled === "boolean"
      ? commands.nativeCommandsAutoEnabled
      : undefined;
  const nativeSkillsAutoEnabled =
    typeof commands.nativeSkillsAutoEnabled === "boolean"
      ? commands.nativeSkillsAutoEnabled
      : undefined;
  return nativeCommandsAutoEnabled !== undefined || nativeSkillsAutoEnabled !== undefined
    ? {
        ...(nativeCommandsAutoEnabled !== undefined ? { nativeCommandsAutoEnabled } : {}),
        ...(nativeSkillsAutoEnabled !== undefined ? { nativeSkillsAutoEnabled } : {}),
      }
    : undefined;
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
    "showConfigured",
    "showInSetup",
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
  const commands = normalizePackageChannelCommands(value.commands);
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

function resolveInstalledPackageMetadata(record: InstalledPluginIndexRecord): {
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
} {
  const recordPackageChannel = normalizePersistedPackageChannel(record.packageChannel);
  const fallbackPackageManifest = recordPackageChannel
    ? {
        channel: recordPackageChannel,
      }
    : undefined;
  const packageJsonPath = record.packageJson?.path ? resolvePackageJsonPath(record) : undefined;
  if (!packageJsonPath) {
    return fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {};
  }
  const packageJson = tryReadJsonSync<PackageManifest>(packageJsonPath);
  if (packageJson) {
    const packageManifest = getPackageManifestMetadata(packageJson);
    const dependencies = normalizePluginDependencySpecs({
      dependencies: packageJson.dependencies,
      optionalDependencies: packageJson.optionalDependencies,
    });
    if (!packageManifest) {
      return {
        ...(fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {}),
        packageDependencies: dependencies.dependencies,
        packageOptionalDependencies: dependencies.optionalDependencies,
      };
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
    return {
      packageManifest: {
        ...packageManifestWithoutChannel,
        ...(channel ? { channel } : {}),
      },
      packageDependencies: dependencies.dependencies,
      packageOptionalDependencies: dependencies.optionalDependencies,
    };
  }
  return fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {};
}

function toPluginCandidate(record: InstalledPluginIndexRecord): PluginCandidate {
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageMetadata = resolveInstalledPackageMetadata(record);
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
      const diagnostics = pluginIdSet
        ? params.index.diagnostics.filter((diagnostic) => {
            const pluginId = diagnostic.pluginId;
            return !pluginId || pluginIdSet.has(pluginId);
          })
        : params.index.diagnostics;
      const candidates = params.index.plugins
        .filter((plugin) => params.includeDisabled || plugin.enabled)
        .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId))
        .map(toPluginCandidate);
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
