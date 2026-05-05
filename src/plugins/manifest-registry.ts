import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeOptionalTrimmedStringList } from "../shared/string-normalization.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { normalizePluginsConfigWithResolver } from "./config-policy.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { PluginManifestCommandAlias } from "./manifest-command-aliases.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
} from "./manifest-types.js";
import {
  loadPluginManifest,
  type OpenClawPackageManifest,
  type PluginManifestActivation,
  type PluginManifestConfigContracts,
  type PluginManifest,
  type PluginManifestCapabilityProviderMetadata,
  type PluginManifestChannelCommandDefaults,
  type PluginManifestChannelConfig,
  type PluginManifestContracts,
  type PluginManifestMediaUnderstandingProviderMetadata,
  type PluginManifestModelCatalog,
  type PluginManifestModelIdNormalization,
  type PluginManifestModelPricing,
  type PluginManifestModelSupport,
  type PluginManifestProviderEndpoint,
  type PluginManifestProviderRequest,
  type PluginManifestQaRunner,
  type PluginManifestSetup,
  type PluginManifestToolMetadata,
  type PluginPackageChannel,
  type PluginPackageInstall,
} from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginDependencySpecMap } from "./status-dependencies.js";

/**
 * Resolve a plugin source path, falling back from .ts to .js when the
 * .ts file doesn't exist on disk (e.g. in dist builds where only .js
 * is emitted but the manifest still references the .ts entry).
 */
function resolvePluginSourcePath(sourcePath: string): string {
  if (fs.existsSync(sourcePath)) {
    return sourcePath;
  }
  if (sourcePath.endsWith(".ts")) {
    const jsPath = sourcePath.slice(0, -3) + ".js";
    if (fs.existsSync(jsPath)) {
      return jsPath;
    }
  }
  return sourcePath;
}

export type PluginManifestContractListKey =
  | "speechProviders"
  | "externalAuthProviders"
  | "mediaUnderstandingProviders"
  | "documentExtractors"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "memoryEmbeddingProviders"
  | "webContentExtractors"
  | "webFetchProviders"
  | "webSearchProviders"
  | "migrationProviders";

type SeenIdEntry = {
  candidate: PluginCandidate;
  recordIndex: number;
};

// Canonicalize identical physical plugin roots with the most explicit source.
// This only applies when multiple candidates resolve to the same on-disk plugin.
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

export type PluginManifestRecord = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: string[];
  autoEnableWhenConfiguredProviders?: string[];
  legacyPluginIds?: string[];
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  channels: string[];
  providers: string[];
  providerDiscoverySource?: string;
  modelSupport?: PluginManifestModelSupport;
  modelCatalog?: PluginManifestModelCatalog;
  modelPricing?: PluginManifestModelPricing;
  modelIdNormalization?: PluginManifestModelIdNormalization;
  providerEndpoints?: PluginManifestProviderEndpoint[];
  providerRequest?: PluginManifestProviderRequest;
  cliBackends: string[];
  syntheticAuthRefs?: string[];
  nonSecretAuthMarkers?: string[];
  commandAliases?: PluginManifestCommandAlias[];
  providerAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  channelEnvVars?: Record<string, string[]>;
  providerAuthChoices?: PluginManifest["providerAuthChoices"];
  activation?: PluginManifestActivation;
  setup?: PluginManifestSetup;
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
  packageChannel?: PluginPackageChannel;
  packageInstall?: PluginPackageInstall;
  trustedOfficialInstall?: boolean;
  qaRunners?: PluginManifestQaRunner[];
  skills: string[];
  settingsFiles?: string[];
  hooks: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  contracts?: PluginManifestContracts;
  mediaUnderstandingProviderMetadata?: Record<
    string,
    PluginManifestMediaUnderstandingProviderMetadata
  >;
  imageGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  videoGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  musicGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  toolMetadata?: Record<string, PluginManifestToolMetadata>;
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  channelCatalogMeta?: {
    id: string;
    label?: string;
    blurb?: string;
    preferOver?: readonly string[];
    commands?: PluginManifestChannelCommandDefaults;
  };
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

export type BundledChannelConfigCollector = (params: {
  pluginDir: string;
  manifest: PluginManifest;
  packageManifest?: OpenClawPackageManifest;
}) => Record<string, PluginManifestChannelConfig> | undefined;

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizePreferredPluginIds(raw: unknown): string[] | undefined {
  return normalizeOptionalTrimmedStringList(raw);
}

function normalizePackageChannelCommands(
  commands: unknown,
): PluginManifestChannelCommandDefaults | undefined {
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return undefined;
  }
  const record = commands as Record<string, unknown>;
  const nativeCommandsAutoEnabled =
    typeof record.nativeCommandsAutoEnabled === "boolean"
      ? record.nativeCommandsAutoEnabled
      : undefined;
  const nativeSkillsAutoEnabled =
    typeof record.nativeSkillsAutoEnabled === "boolean"
      ? record.nativeSkillsAutoEnabled
      : undefined;
  return nativeCommandsAutoEnabled !== undefined || nativeSkillsAutoEnabled !== undefined
    ? {
        ...(nativeCommandsAutoEnabled !== undefined ? { nativeCommandsAutoEnabled } : {}),
        ...(nativeSkillsAutoEnabled !== undefined ? { nativeSkillsAutoEnabled } : {}),
      }
    : undefined;
}

function mergePackageChannelMetaIntoChannelConfigs(params: {
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  packageChannel?: OpenClawPackageManifest["channel"];
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelId = params.packageChannel?.id?.trim();
  if (
    !channelId ||
    isBlockedObjectKey(channelId) ||
    !params.channelConfigs ||
    !Object.prototype.hasOwnProperty.call(params.channelConfigs, channelId)
  ) {
    return params.channelConfigs;
  }

  const existing = params.channelConfigs[channelId];
  if (!existing) {
    return params.channelConfigs;
  }
  const label = existing.label ?? normalizeOptionalString(params.packageChannel?.label) ?? "";
  const description =
    existing.description ?? normalizeOptionalString(params.packageChannel?.blurb) ?? "";
  const preferOver =
    existing.preferOver ?? normalizePreferredPluginIds(params.packageChannel?.preferOver);
  const commands =
    existing.commands ?? normalizePackageChannelCommands(params.packageChannel?.commands);

  const merged: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, value] of Object.entries(params.channelConfigs)) {
    if (!isBlockedObjectKey(key)) {
      merged[key] = value;
    }
  }
  merged[channelId] = {
    ...existing,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(preferOver?.length ? { preferOver } : {}),
    ...(commands ? { commands } : {}),
  };
  return merged;
}

function mergeContractLists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])]
    .map((value) => value.trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  return merged.length > 0 ? merged : undefined;
}

function mergeManifestContracts(
  manifestContracts: PluginManifestContracts | undefined,
  catalogContracts: PluginManifestContracts | undefined,
): PluginManifestContracts | undefined {
  if (!catalogContracts) {
    return manifestContracts;
  }
  const contracts: PluginManifestContracts = {};
  for (const key of [
    "embeddedExtensionFactories",
    "agentToolResultMiddleware",
    "externalAuthProviders",
    "memoryEmbeddingProviders",
    "speechProviders",
    "realtimeTranscriptionProviders",
    "realtimeVoiceProviders",
    "mediaUnderstandingProviders",
    "documentExtractors",
    "imageGenerationProviders",
    "videoGenerationProviders",
    "musicGenerationProviders",
    "webContentExtractors",
    "webFetchProviders",
    "webSearchProviders",
    "migrationProviders",
    "tools",
  ] as const) {
    const merged = mergeContractLists(manifestContracts?.[key], catalogContracts[key]);
    if (merged) {
      contracts[key] = merged;
    }
  }
  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function mergeCatalogChannelConfigs(params: {
  manifestChannelConfigs?: Record<string, PluginManifestChannelConfig>;
  catalogChannelConfigs?: Record<string, PluginManifestChannelConfig>;
}): Record<string, PluginManifestChannelConfig> | undefined {
  if (!params.catalogChannelConfigs) {
    return params.manifestChannelConfigs;
  }
  const merged: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, value] of Object.entries(params.catalogChannelConfigs)) {
    if (!isBlockedObjectKey(key)) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(params.manifestChannelConfigs ?? {})) {
    if (!isBlockedObjectKey(key)) {
      const catalogValue = merged[key];
      merged[key] = catalogValue
        ? {
            ...catalogValue,
            ...value,
            schema: value.schema ?? catalogValue.schema,
            ...(catalogValue.uiHints || value.uiHints
              ? {
                  uiHints: {
                    ...catalogValue.uiHints,
                    ...value.uiHints,
                  },
                }
              : {}),
            ...((value.runtime ?? catalogValue.runtime)
              ? { runtime: value.runtime ?? catalogValue.runtime }
              : {}),
            ...((value.label ?? catalogValue.label)
              ? { label: value.label ?? catalogValue.label }
              : {}),
            ...((value.description ?? catalogValue.description)
              ? { description: value.description ?? catalogValue.description }
              : {}),
            ...((value.preferOver ?? catalogValue.preferOver)
              ? { preferOver: value.preferOver ?? catalogValue.preferOver }
              : {}),
            ...((value.commands ?? catalogValue.commands)
              ? { commands: value.commands ?? catalogValue.commands }
              : {}),
          }
        : value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
  trustedOfficialInstall?: boolean;
}): PluginManifestRecord {
  const manifestChannelConfigs =
    params.candidate.origin === "bundled" && params.bundledChannelConfigCollector
      ? params.bundledChannelConfigCollector({
          pluginDir: params.candidate.packageDir ?? params.candidate.rootDir,
          manifest: params.manifest,
          packageManifest: params.candidate.packageManifest,
        })
      : params.manifest.channelConfigs;
  const officialCatalogManifest =
    params.candidate.origin !== "bundled"
      ? getOfficialExternalPluginCatalogManifest(
          getOfficialExternalPluginCatalogEntryForPackage(params.candidate.packageName) ?? {},
        )
      : undefined;
  const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
    channelConfigs: mergeCatalogChannelConfigs({
      manifestChannelConfigs,
      catalogChannelConfigs: officialCatalogManifest?.channelConfigs,
    }),
    packageChannel: params.candidate.packageManifest?.channel,
  });
  const packageChannelCommands = normalizePackageChannelCommands(
    params.candidate.packageManifest?.channel?.commands,
  );
  return {
    id: params.manifest.id,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeOptionalString(params.manifest.description) ?? params.candidate.packageDescription,
    version: normalizeOptionalString(params.manifest.version) ?? params.candidate.packageVersion,
    packageName: params.candidate.packageName,
    packageVersion: params.candidate.packageVersion,
    packageDescription: params.candidate.packageDescription,
    enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
    enabledByDefaultOnPlatforms: params.manifest.enabledByDefaultOnPlatforms,
    autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
    legacyPluginIds: params.manifest.legacyPluginIds,
    format: params.candidate.format ?? "openclaw",
    bundleFormat: params.candidate.bundleFormat,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    providerDiscoverySource: params.manifest.providerDiscoveryEntry
      ? resolvePluginSourcePath(
          path.resolve(params.candidate.rootDir, params.manifest.providerDiscoveryEntry),
        )
      : undefined,
    modelSupport: params.manifest.modelSupport,
    modelCatalog: params.manifest.modelCatalog,
    modelPricing: params.manifest.modelPricing,
    modelIdNormalization: params.manifest.modelIdNormalization,
    providerEndpoints: params.manifest.providerEndpoints,
    providerRequest: params.manifest.providerRequest,
    cliBackends: params.manifest.cliBackends ?? [],
    syntheticAuthRefs: params.manifest.syntheticAuthRefs ?? [],
    nonSecretAuthMarkers: params.manifest.nonSecretAuthMarkers ?? [],
    commandAliases: params.manifest.commandAliases,
    providerAuthEnvVars: params.manifest.providerAuthEnvVars,
    providerAuthAliases: params.manifest.providerAuthAliases,
    channelEnvVars: params.manifest.channelEnvVars,
    providerAuthChoices: params.manifest.providerAuthChoices,
    activation: params.manifest.activation,
    setup: params.manifest.setup,
    packageManifest: params.candidate.packageManifest,
    packageDependencies: params.candidate.packageDependencies,
    packageOptionalDependencies: params.candidate.packageOptionalDependencies,
    packageChannel: params.candidate.packageManifest?.channel,
    packageInstall: params.candidate.packageManifest?.install,
    trustedOfficialInstall: params.trustedOfficialInstall === true ? true : undefined,
    qaRunners: params.manifest.qaRunners,
    skills: params.manifest.skills ?? [],
    settingsFiles: [],
    hooks: [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    setupSource: params.candidate.setupSource,
    startupDeferConfiguredChannelFullLoadUntilAfterListen:
      params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen ===
      true,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
    contracts: mergeManifestContracts(
      params.manifest.contracts,
      officialCatalogManifest?.contracts,
    ),
    mediaUnderstandingProviderMetadata: params.manifest.mediaUnderstandingProviderMetadata,
    imageGenerationProviderMetadata: params.manifest.imageGenerationProviderMetadata,
    videoGenerationProviderMetadata: params.manifest.videoGenerationProviderMetadata,
    musicGenerationProviderMetadata: params.manifest.musicGenerationProviderMetadata,
    toolMetadata: params.manifest.toolMetadata,
    configContracts: params.manifest.configContracts,
    channelConfigs,
    ...(params.candidate.packageManifest?.channel?.id
      ? {
          channelCatalogMeta: {
            id: params.candidate.packageManifest.channel.id,
            ...(typeof params.candidate.packageManifest.channel.label === "string"
              ? { label: params.candidate.packageManifest.channel.label }
              : {}),
            ...(typeof params.candidate.packageManifest.channel.blurb === "string"
              ? { blurb: params.candidate.packageManifest.channel.blurb }
              : {}),
            ...(params.candidate.packageManifest.channel.preferOver
              ? { preferOver: params.candidate.packageManifest.channel.preferOver }
              : {}),
            ...(packageChannelCommands ? { commands: packageChannelCommands } : {}),
          },
        }
      : {}),
  };
}

function buildBundleRecord(params: {
  manifest: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    skills: string[];
    settingsFiles?: string[];
    hooks: string[];
    capabilities: string[];
  };
  candidate: PluginCandidate;
  manifestPath: string;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.idHint,
    description: normalizeOptionalString(params.manifest.description),
    version: normalizeOptionalString(params.manifest.version),
    packageName: params.candidate.packageName,
    packageVersion: params.candidate.packageVersion,
    packageDescription: params.candidate.packageDescription,
    packageManifest: params.candidate.packageManifest,
    packageDependencies: params.candidate.packageDependencies,
    packageOptionalDependencies: params.candidate.packageOptionalDependencies,
    packageChannel: params.candidate.packageManifest?.channel,
    packageInstall: params.candidate.packageManifest?.install,
    format: "bundle",
    bundleFormat: params.candidate.bundleFormat,
    bundleCapabilities: params.manifest.capabilities,
    channels: [],
    providers: [],
    cliBackends: [],
    syntheticAuthRefs: [],
    nonSecretAuthMarkers: [],
    skills: params.manifest.skills ?? [],
    settingsFiles: params.manifest.settingsFiles ?? [],
    hooks: params.manifest.hooks ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: undefined,
    configSchema: undefined,
    configUiHints: undefined,
    configContracts: undefined,
    channelConfigs: undefined,
  };
}

function pushProviderAuthEnvVarsCompatDiagnostic(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
}): void {
  if (params.record.origin === "bundled" || !params.record.providerAuthEnvVars) {
    return;
  }
  const setupProviderEnvVars = new Map(
    (params.record.setup?.providers ?? []).map(
      (provider) => [provider.id, new Set(provider.envVars ?? [])] as const,
    ),
  );
  const providerIds = Object.entries(params.record.providerAuthEnvVars)
    .filter(([providerId, envVars]) => {
      if (!providerId.trim() || envVars.length === 0) {
        return false;
      }
      const mirroredEnvVars = setupProviderEnvVars.get(providerId);
      return !mirroredEnvVars || envVars.some((envVar) => !mirroredEnvVars.has(envVar));
    })
    .map(([providerId]) => providerId)
    .toSorted((left, right) => left.localeCompare(right));
  if (providerIds.length === 0) {
    return;
  }
  params.diagnostics.push({
    level: "warn",
    pluginId: sanitizeForLog(params.record.id),
    source: sanitizeForLog(params.record.manifestPath),
    message: `providerAuthEnvVars is deprecated compatibility metadata for provider env-var lookup; mirror ${providerIds.map(sanitizeForLog).join(", ")} env vars to setup.providers[].envVars before the deprecation window closes`,
  });
}

function pushNonBundledChannelConfigDescriptorDiagnostic(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
  normalized?: ReturnType<typeof normalizePluginsConfigWithResolver>;
}): void {
  if (params.record.origin === "bundled" || params.record.format === "bundle") {
    return;
  }
  const configuredEntry = params.normalized?.entries[params.record.id];
  if (
    params.normalized?.enabled === false ||
    configuredEntry?.enabled === false ||
    params.normalized?.deny.includes(params.record.id) ||
    (params.normalized?.allow.length && !params.normalized.allow.includes(params.record.id))
  ) {
    return;
  }
  const declaredChannels = params.record.channels
    .map((channelId) => channelId.trim())
    .filter((channelId) => channelId.length > 0);
  if (declaredChannels.length === 0) {
    return;
  }
  const channelConfigs = params.record.channelConfigs ?? {};
  const missingChannels = declaredChannels.filter(
    (channelId) => !Object.prototype.hasOwnProperty.call(channelConfigs, channelId),
  );
  if (missingChannels.length === 0) {
    return;
  }
  const safeMissingChannels = missingChannels.map(sanitizeForLog);
  params.diagnostics.push({
    level: "warn",
    pluginId: sanitizeForLog(params.record.id),
    source: sanitizeForLog(params.record.manifestPath),
    message: `channel plugin manifest declares ${safeMissingChannels.join(", ")} without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads`,
  });
}

function pushManifestCompatibilityDiagnostics(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
  normalized?: ReturnType<typeof normalizePluginsConfigWithResolver>;
}): void {
  pushProviderAuthEnvVarsCompatDiagnostic(params);
  pushNonBundledChannelConfigDescriptorDiagnostic(params);
}

function dedupePluginDiagnostics(diagnostics: PluginDiagnostic[]): PluginDiagnostic[] {
  const seen = new Set<string>();
  const deduped: PluginDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.level, diagnostic.pluginId ?? "", diagnostic.message]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  if (params.candidate.origin !== "global" && params.candidate.origin !== "config") {
    return false;
  }
  const record = params.installRecords[params.pluginId];
  if (!record) {
    return false;
  }
  const candidateSource = resolveUserPath(params.candidate.source, params.env);
  const trackedPaths = [record.installPath, record.sourcePath]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => resolveUserPath(entry, params.env));
  if (trackedPaths.length === 0) {
    return false;
  }
  return trackedPaths.some((trackedPath) => {
    return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
  });
}

function npmSpecMatchesPackage(value: string | undefined, packageName: string): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return false;
  }
  if (normalized === packageName) {
    return true;
  }
  return normalized.startsWith(`${packageName}@`);
}

function isTrustedOfficialPluginInstall(params: {
  pluginId: string;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  if (
    (params.candidate.origin !== "global" && params.candidate.origin !== "config") ||
    !matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      env: params.env,
      installRecords: params.installRecords,
    })
  ) {
    return false;
  }
  const packageName = params.candidate.packageName?.trim();
  if (!packageName) {
    return false;
  }
  const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
  if (!catalogEntry || resolveOfficialExternalPluginId(catalogEntry) !== params.pluginId) {
    return false;
  }
  const officialInstall = resolveOfficialExternalPluginInstall(catalogEntry);
  const installRecord = params.installRecords[params.pluginId];
  if (!installRecord) {
    return false;
  }
  if (
    installRecord.source === "npm" &&
    officialInstall?.npmSpec === packageName &&
    [
      installRecord.resolvedName,
      installRecord.spec,
      installRecord.resolvedSpec,
      params.candidate.packageName,
    ].some((value) => npmSpecMatchesPackage(value, packageName))
  ) {
    return true;
  }
  if (
    installRecord.source === "clawhub" &&
    officialInstall?.clawhubSpec &&
    installRecord.clawhubChannel === "official" &&
    (installRecord.clawhubPackage === packageName ||
      installRecord.spec === officialInstall.clawhubSpec ||
      installRecord.resolvedSpec === officialInstall.clawhubSpec)
  ) {
    return true;
  }
  return false;
}

function resolveDuplicatePrecedenceRank(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): number {
  if (params.candidate.origin === "config") {
    return 0;
  }
  if (
    params.candidate.origin === "global" &&
    matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      config: params.config,
      env: params.env,
      installRecords: params.installRecords,
    })
  ) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids are reserved unless the operator explicitly overrides them.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

function isIntentionalInstalledBundledDuplicate(params: {
  pluginId: string;
  left: PluginCandidate;
  right: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  const leftIsInstalled = matchesInstalledPluginRecord({
    pluginId: params.pluginId,
    candidate: params.left,
    config: params.config,
    env: params.env,
    installRecords: params.installRecords,
  });
  const rightIsInstalled = matchesInstalledPluginRecord({
    pluginId: params.pluginId,
    candidate: params.right,
    config: params.config,
    env: params.env,
    installRecords: params.installRecords,
  });
  return (
    (leftIsInstalled && params.right.origin === "bundled") ||
    (rightIsInstalled && params.left.origin === "bundled")
  );
}

function isSameGlobalPackageDuplicate(left: PluginCandidate, right: PluginCandidate): boolean {
  if (left.origin !== "global" || right.origin !== "global") {
    return false;
  }
  const leftPackageName = normalizeOptionalString(left.packageName);
  const rightPackageName = normalizeOptionalString(right.packageName);
  if (!leftPackageName || leftPackageName !== rightPackageName) {
    return false;
  }
  const leftPackageVersion = normalizeOptionalString(left.packageVersion);
  const rightPackageVersion = normalizeOptionalString(right.packageVersion);
  return Boolean(
    leftPackageVersion && rightPackageVersion && leftPackageVersion === rightPackageVersion,
  );
}

export function loadPluginManifestRegistry(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    candidates?: PluginCandidate[];
    diagnostics?: PluginDiagnostic[];
    installRecords?: Record<string, PluginInstallRecord>;
    bundledChannelConfigCollector?: BundledChannelConfigCollector;
  } = {},
): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfigWithResolver(config.plugins);
  const env = params.env ?? process.env;
  let installRecords = params.installRecords;
  let installRecordsLoaded = Boolean(params.installRecords);
  const getInstallRecords = (): Record<string, PluginInstallRecord> => {
    if (!installRecordsLoaded) {
      installRecords = loadInstalledPluginIndexInstallRecordsSync({ env });
      installRecordsLoaded = true;
    }
    return installRecords ?? {};
  };

  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
        env,
        installRecords: getInstallRecords(),
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Map<string, SeenIdEntry>();
  const realpathCache = new Map<string, string>();
  const currentHostVersion = resolveCompatibilityHostVersion(env);

  for (const candidate of candidates) {
    const rejectHardlinks = candidate.origin !== "bundled";
    const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
    const manifestRes:
      | ReturnType<typeof loadPluginManifest>
      | ReturnType<typeof loadBundleManifest>
      | { ok: true; manifest: PluginManifest; manifestPath: string } =
      candidate.origin === "bundled" && candidate.bundledManifest && candidate.bundledManifestPath
        ? {
            ok: true,
            manifest: candidate.bundledManifest,
            manifestPath: candidate.bundledManifestPath,
          }
        : isBundleRecord && candidate.bundleFormat
          ? loadBundleManifest({
              rootDir: candidate.rootDir,
              bundleFormat: candidate.bundleFormat,
              rejectHardlinks,
            })
          : loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const manifest = manifestRes.manifest;
    if (candidate.origin !== "bundled") {
      const allowLegacyBareMinHostVersion =
        candidate.origin === "global" &&
        matchesInstalledPluginRecord({
          pluginId: manifest.id,
          candidate,
          config,
          env,
          installRecords: getInstallRecords(),
        });
      const minHostVersionCheck = checkMinHostVersion({
        currentVersion: currentHostVersion,
        minHostVersion: candidate.packageManifest?.install?.minHostVersion,
        allowLegacyBareSemver: allowLegacyBareMinHostVersion,
      });
      if (!minHostVersionCheck.ok) {
        const packageManifestSource = path.join(
          candidate.packageDir ?? candidate.rootDir,
          "package.json",
        );
        diagnostics.push({
          level: minHostVersionCheck.kind === "invalid" ? "error" : "warn",
          pluginId: manifest.id,
          source: packageManifestSource,
          message:
            minHostVersionCheck.kind === "invalid"
              ? `plugin manifest invalid | ${minHostVersionCheck.error}`
              : minHostVersionCheck.kind === "unknown_host_version"
                ? `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load`
                : `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`,
        });
        continue;
      }
    }

    const configSchema = "configSchema" in manifest ? manifest.configSchema : undefined;
    const schemaCacheKey = (() => {
      if (!configSchema) {
        return undefined;
      }
      const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
      return manifestMtime
        ? `${manifestRes.manifestPath}:${manifestMtime}`
        : manifestRes.manifestPath;
    })();

    const record = isBundleRecord
      ? buildBundleRecord({
          manifest: manifest as Parameters<typeof buildBundleRecord>[0]["manifest"],
          candidate,
          manifestPath: manifestRes.manifestPath,
        })
      : buildRecord({
          manifest: manifest as PluginManifest,
          candidate,
          manifestPath: manifestRes.manifestPath,
          schemaCacheKey,
          configSchema,
          trustedOfficialInstall: isTrustedOfficialPluginInstall({
            pluginId: manifest.id,
            candidate,
            env,
            installRecords: getInstallRecords(),
          }),
          ...(params.bundledChannelConfigCollector
            ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
            : {}),
        });

    const existing = seenIds.get(manifest.id);
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // is a false-positive duplicate and can be silently skipped.
      const samePath = existing.candidate.rootDir === candidate.rootDir;
      const samePlugin = (() => {
        if (samePath) {
          return true;
        }
        const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
        const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
        return Boolean(existingReal && candidateReal && existingReal === candidateReal);
      })();
      if (samePlugin) {
        // Prefer higher-precedence origins even if candidates are passed in
        // an unexpected order (config > workspace > global > bundled).
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          records[existing.recordIndex] = record;
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
          pushManifestCompatibilityDiagnostics({ record, diagnostics, normalized });
        }
        continue;
      }

      const candidateRank = resolveDuplicatePrecedenceRank({
        pluginId: manifest.id,
        candidate,
        config,
        env,
        installRecords: getInstallRecords(),
      });
      const existingRank = resolveDuplicatePrecedenceRank({
        pluginId: manifest.id,
        candidate: existing.candidate,
        config,
        env,
        installRecords: getInstallRecords(),
      });
      const candidateWins = candidateRank < existingRank;
      const winnerCandidate = candidateWins ? candidate : existing.candidate;
      const overriddenCandidate = candidateWins ? existing.candidate : candidate;
      if (candidateWins) {
        records[existing.recordIndex] = record;
        seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        pushManifestCompatibilityDiagnostics({ record, diagnostics, normalized });
      }
      if (
        isIntentionalInstalledBundledDuplicate({
          pluginId: manifest.id,
          left: candidate,
          right: existing.candidate,
          config,
          env,
          installRecords: getInstallRecords(),
        })
      ) {
        continue;
      }
      if (isSameGlobalPackageDuplicate(candidate, existing.candidate)) {
        continue;
      }
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: overriddenCandidate.source,
        message:
          winnerCandidate.origin === "config"
            ? `duplicate plugin id resolved by explicit config-selected plugin; ${overriddenCandidate.origin} plugin will be overridden by config plugin (${winnerCandidate.source})`
            : `duplicate plugin id detected; ${overriddenCandidate.origin} plugin will be overridden by ${winnerCandidate.origin} plugin (${winnerCandidate.source})`,
      });
      continue;
    }

    seenIds.set(manifest.id, { candidate, recordIndex: records.length });
    records.push(record);
    pushManifestCompatibilityDiagnostics({ record, diagnostics, normalized });
  }

  const registry = { plugins: records, diagnostics: dedupePluginDiagnostics(diagnostics) };
  return registry;
}
