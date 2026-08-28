/** Builds manifest registry records from installed plugin index snapshots. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  resolveChannelSetupFieldCliAttributeName,
  type ChannelSetupFieldMetadata,
} from "../channels/plugins/setup-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRecord,
  type PluginManifestRegistry,
  type BundledChannelConfigCollector,
} from "./manifest-registry.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  normalizeManifestChannelCommandDefaults,
  type OpenClawPackageManifest,
  type PluginPackageChannel,
  type PluginPackageChannelCliOption,
} from "./manifest.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import { getPluginCache } from "./plugin-cache.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import {
  normalizePluginDependencySpecs,
  type PluginDependencySpecMap,
} from "./status-dependencies-core.js";

type InstalledPackageMetadata = {
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
};

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

export function resolveInstalledManifestRegistryIndexFingerprint(
  index: InstalledPluginIndex,
): string {
  const cached = getPluginCache().metadata.indexFingerprints.get(index);
  if (cached) {
    return cached;
  }
  // The immutable installed inventory owns freshness; lifecycle clears publish
  // a replacement instead of polling manifests or package paths on hot reads.
  const fingerprint = hashStableJson({
    version: index.version,
    hostContractVersion: index.hostContractVersion,
    compatRegistryVersion: index.compatRegistryVersion,
    migrationVersion: index.migrationVersion,
    policyHash: index.policyHash,
    installRecords: index.installRecords,
    diagnostics: index.diagnostics,
    plugins: index.plugins.map(
      ({ doctorContractFile: _doctorContractFile, packageBuild, ...plugin }) => ({
        ...plugin,
        ...(packageBuild
          ? {
              packageBuild:
                packageBuild.bundledDist === undefined
                  ? {}
                  : { bundledDist: packageBuild.bundledDist },
            }
          : {}),
      }),
    ),
  });
  if (isDeepFrozenJsonLike(index)) {
    getPluginCache().metadata.indexFingerprints.set(index, fingerprint);
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
    if (pluginCacheExistsSync(candidate)) {
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
  const normalized: NonNullable<PluginPackageChannel["exposure"]> = {};
  for (const key of ["configured", "setup", "docs"] as const) {
    if (typeof exposure[key] === "boolean") {
      normalized[key] = exposure[key];
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
  const normalized: NonNullable<PluginPackageChannel["doctorCapabilities"]> = {};
  const { dmAllowFromMode, groupModel } = doctorCapabilities;
  if (
    dmAllowFromMode === "topOnly" ||
    dmAllowFromMode === "topOrNested" ||
    dmAllowFromMode === "nestedOnly"
  ) {
    normalized.dmAllowFromMode = dmAllowFromMode;
  }
  if (groupModel === "sender" || groupModel === "route" || groupModel === "hybrid") {
    normalized.groupModel = groupModel;
  }
  for (const key of [
    "openDmRequiresAllowFromWildcard",
    "groupAllowFromFallbackToAllowFrom",
    "warnOnEmptyGroupSenderAllowlist",
  ] as const) {
    if (typeof doctorCapabilities[key] === "boolean") {
      normalized[key] = doctorCapabilities[key];
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePackageChannelCliOptions(
  cliAddOptions: unknown,
): PluginPackageChannel["cliAddOptions"] | undefined {
  if (!Array.isArray(cliAddOptions)) {
    return undefined;
  }
  const normalized = cliAddOptions.flatMap<PluginPackageChannelCliOption>((option) => {
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
    const valueType =
      option.valueType === "int" || option.valueType === "list" ? option.valueType : undefined;
    return [
      {
        flags,
        description,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(valueType ? { valueType } : {}),
      },
    ];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePackageChannelSetup(setup: unknown): PluginPackageChannel["setup"] | undefined {
  if (!isRecord(setup) || !Array.isArray(setup.fields)) {
    return undefined;
  }
  const fields: ChannelSetupFieldMetadata[] = [];
  for (const value of setup.fields) {
    if (!isRecord(value) || !isRecord(value.cli)) {
      continue;
    }
    const key = normalizeOptionalString(value.key);
    const kind = normalizeOptionalString(value.kind);
    const flags = normalizeOptionalString(value.cli.flags);
    const negatedFlags = normalizeOptionalString(value.cli.negatedFlags);
    const description = normalizeOptionalString(value.cli.description);
    if (
      !key ||
      !flags ||
      !description ||
      !kind ||
      (kind !== "string" &&
        kind !== "boolean" &&
        kind !== "integer" &&
        kind !== "string-list" &&
        kind !== "choice")
    ) {
      continue;
    }
    try {
      if (
        resolveChannelSetupFieldCliAttributeName(flags) !== key ||
        (negatedFlags && resolveChannelSetupFieldCliAttributeName(negatedFlags) !== key)
      ) {
        continue;
      }
    } catch {
      continue;
    }
    const defaultValue =
      typeof value.cli.defaultValue === "boolean" || typeof value.cli.defaultValue === "string"
        ? value.cli.defaultValue
        : undefined;
    const cli = {
      flags,
      ...(negatedFlags ? { negatedFlags } : {}),
      description,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
    if (kind === "choice") {
      const choices = normalizeOptionalTrimmedStringList(value.choices);
      if (!choices?.length) {
        continue;
      }
      fields.push({ key, kind, choices, cli });
      continue;
    }
    if (kind === "string" || kind === "string-list") {
      fields.push({
        key,
        kind,
        ...(value.sensitive === true ? { sensitive: true } : {}),
        cli,
      });
      continue;
    }
    if (kind === "boolean") {
      const envVars = normalizeOptionalTrimmedStringList(value.envVars);
      const envVarMode =
        value.envVarMode === "any" || value.envVarMode === "all" ? value.envVarMode : undefined;
      fields.push({
        key,
        kind,
        ...(envVars?.length ? { envVars } : {}),
        ...(envVars?.length && envVarMode ? { envVarMode } : {}),
        cli,
      });
      continue;
    }
    fields.push({ key, kind, cli });
  }
  return { fields };
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
  ] as const) {
    const normalized = normalizeOptionalString(value[key]);
    if (normalized) {
      channel[key] = normalized;
    }
  }
  const selectionDocsPrefix = readStringValue(value.selectionDocsPrefix);
  if (selectionDocsPrefix !== undefined) {
    channel.selectionDocsPrefix = selectionDocsPrefix;
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
  if (Array.isArray(value.approvalFlags) && value.approvalFlags.includes("native")) {
    channel.approvalFlags = ["native"];
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
  for (const [key, normalize] of [
    ["exposure", normalizePackageChannelExposure],
    ["commands", normalizeManifestChannelCommandDefaults],
    ["configuredState", normalizePackageChannelConfiguredState],
    ["persistedAuthState", normalizePackageChannelPersistedAuthState],
    ["doctorCapabilities", normalizePackageChannelDoctorCapabilities],
    ["setup", normalizePackageChannelSetup],
    ["cliAddOptions", normalizePackageChannelCliOptions],
  ] as const) {
    const normalized = normalize(value[key]);
    if (normalized) {
      Object.assign(channel, { [key]: normalized });
    }
  }
  return channel;
}

function normalizePreparedManifestRecord(record: PluginManifestRecord): PluginManifestRecord {
  if (!record.packageManifest?.channel && !record.packageChannel) {
    return record;
  }
  const packageChannel = normalizePersistedPackageChannel(
    record.packageManifest?.channel ?? record.packageChannel,
  );
  const { channel: _ignoredChannel, ...packageManifest } = record.packageManifest ?? {};
  return {
    ...record,
    packageChannel,
    ...(record.packageManifest
      ? {
          packageManifest: {
            ...packageManifest,
            ...(packageChannel ? { channel: packageChannel } : {}),
          },
        }
      : {}),
    ...(!packageChannel && record.channelCatalogMeta ? { channelCatalogMeta: undefined } : {}),
  };
}

function resolveInstalledPackageMetadata(
  record: InstalledPluginIndexRecord,
  env: NodeJS.ProcessEnv,
): InstalledPackageMetadata {
  const recordPackageChannel = normalizePersistedPackageChannel(record.packageChannel);
  const fallbackPackageManifest = recordPackageChannel
    ? { channel: recordPackageChannel }
    : undefined;
  const fallback = fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {};
  if (!record.packageJson?.path) {
    return fallback;
  }
  const rootDir = resolveInstalledPluginRootDir(record);
  const file = readPluginCacheFile({
    rootDir,
    relativePath: record.packageJson.path,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({ origin: record.origin, rootDir, env }),
  });
  const parsed = file.ok ? parsePluginCacheJson(file) : undefined;
  if (!parsed?.ok || !isRecord(parsed.value)) {
    return fallback;
  }
  const packageJson = parsed.value;
  const packageManifest = getPackageManifestMetadata(packageJson);
  const dependencies = normalizePluginDependencySpecs({
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
  });
  if (!packageManifest) {
    return {
      ...fallback,
      packageDependencies: dependencies.dependencies,
      packageOptionalDependencies: dependencies.optionalDependencies,
    };
  }
  const packageChannel = normalizePersistedPackageChannel(packageManifest.channel);
  const channel =
    recordPackageChannel || packageChannel
      ? { ...recordPackageChannel, ...packageChannel }
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

function toPluginCandidate(
  record: InstalledPluginIndexRecord,
  env: NodeJS.ProcessEnv,
): PluginCandidate {
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageMetadata = resolveInstalledPackageMetadata(record, env);
  return recordPluginCandidateInstallOwner(
    {
      idHint: record.pluginId,
      effectivePluginId: record.pluginId,
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
    },
    resolveInstalledPluginIndexInstallOwner(record),
    isInstalledPluginIndexInstallOwnerAmbiguous(record),
  );
}

export function loadPluginManifestRegistryForInstalledIndex(params: {
  index: InstalledPluginIndex;
  manifestRegistry?: PluginManifestRegistry;
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
      if (params.manifestRegistry && !params.bundledChannelConfigCollector) {
        const enabledPluginIds = new Set(
          params.index.plugins
            .filter((plugin) => params.includeDisabled || plugin.enabled)
            .map((plugin) => plugin.pluginId),
        );
        return {
          plugins: params.manifestRegistry.plugins
            .filter((plugin) => enabledPluginIds.has(plugin.id))
            .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.id))
            .map(normalizePreparedManifestRecord),
          diagnostics: [...diagnostics],
        };
      }
      const candidates = params.index.plugins
        .filter((plugin) => params.includeDisabled || plugin.enabled)
        .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId))
        .map((plugin) => toPluginCandidate(plugin, env));
      return loadPluginManifestRegistryCore({
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
