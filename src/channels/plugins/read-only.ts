import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  hasExplicitChannelConfig,
  listConfiguredChannelIdsForReadOnlyScope,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "../../plugins/loader-channel-setup.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import type { PluginDiagnostic } from "../../plugins/manifest-types.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "../../plugins/plugin-module-loader-cache.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import {
  isSafeManifestChannelId,
  normalizeChannelCommandDefaults,
  readOwnRecordValue,
  resolveReadOnlyChannelCommandDefaults,
} from "./read-only-command-defaults.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

const SOURCE_PLUGIN_LOADER_MODULE_CANDIDATES = [
  "../../plugins/loader.js",
  "../../plugins/loader.ts",
] as const;
const BUILT_PLUGIN_LOADER_MODULE_CANDIDATES = [
  "plugins/loader.js",
  "plugins/build-smoke-entry.js",
] as const;
const moduleLoaders: PluginModuleLoaderCache = new Map();
const log = createSubsystemLogger("channels");

type PluginLoaderModule = {
  loadOpenClawPlugins: (params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    cache?: boolean;
    activate?: boolean;
    includeSetupOnlyChannelPlugins?: boolean;
    forceSetupOnlyChannelPlugins?: boolean;
    requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
    onlyPluginIds?: readonly string[];
  }) => {
    channelSetups: Iterable<{
      pluginId: string;
      plugin: ChannelPlugin;
    }>;
    diagnostics?: readonly PluginDiagnostic[];
  };
};

let pluginLoaderModule: PluginLoaderModule | undefined;

function listBuiltPluginLoaderModuleCandidateUrls(importerUrl: string): URL[] {
  let importerPath: string;
  try {
    importerPath = fileURLToPath(importerUrl);
  } catch {
    return [];
  }
  const distMarker = `${path.sep}dist${path.sep}`;
  const distMarkerIndex = importerPath.lastIndexOf(distMarker);
  if (distMarkerIndex < 0) {
    return [];
  }
  // Bundled read-only chunks live under dist/ with hashed names. Source-relative
  // ../../plugins candidates would escape the installed openclaw package there.
  const distRoot = importerPath.slice(0, distMarkerIndex + distMarker.length - 1);
  return BUILT_PLUGIN_LOADER_MODULE_CANDIDATES.map((candidate) =>
    pathToFileURL(path.join(distRoot, candidate)),
  );
}

export function listPluginLoaderModuleCandidateUrls(importerUrl = import.meta.url): URL[] {
  const builtCandidates = listBuiltPluginLoaderModuleCandidateUrls(importerUrl);
  if (builtCandidates.length > 0) {
    return builtCandidates;
  }
  return SOURCE_PLUGIN_LOADER_MODULE_CANDIDATES.map((candidate) => new URL(candidate, importerUrl));
}

function loadPluginLoaderModule(): PluginLoaderModule {
  if (pluginLoaderModule) {
    return pluginLoaderModule;
  }
  for (const candidate of listPluginLoaderModuleCandidateUrls()) {
    const modulePath = fileURLToPath(candidate);
    try {
      const moduleLoader = getCachedPluginModuleLoader({
        cache: moduleLoaders,
        modulePath,
        importerUrl: import.meta.url,
        preferBuiltDist: true,
        loaderFilename: import.meta.url,
        tryNative: true,
      });
      pluginLoaderModule = moduleLoader(modulePath) as PluginLoaderModule;
      return pluginLoaderModule;
    } catch {
      // Try built/runtime source candidates in order.
    }
  }
  throw new Error("Could not load plugin runtime loader for channel setup fallback.");
}

type ReadOnlyChannelPluginOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  activationSourceConfig?: OpenClawConfig;
  includePersistedAuthState?: boolean;
  includeSetupFallbackPlugins?: boolean;
};

type ReadOnlyChannelPluginResolution = {
  plugins: ChannelPlugin[];
  configuredChannelIds: string[];
  missingConfiguredChannelIds: string[];
  loadFailures: ReadOnlyChannelPluginLoadFailure[];
};
type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];
export type ReadOnlyChannelPluginLoadFailure = {
  channelId: string;
  pluginId: string;
  message: string;
  source?: string;
};

function addChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  plugins: Iterable<ChannelPlugin | undefined>,
  options?: {
    onlyIds?: ReadonlySet<string>;
    allowOverwrite?: boolean;
  },
): void {
  for (const plugin of plugins) {
    if (!plugin) {
      continue;
    }
    if (options?.onlyIds && !options.onlyIds.has(plugin.id)) {
      continue;
    }
    if (options?.allowOverwrite === false && byId.has(plugin.id)) {
      continue;
    }
    byId.set(plugin.id, plugin);
  }
}

function rebindChannelScopedString(
  value: string,
  sourceChannelId: string,
  targetChannelId: string,
): string {
  const sourcePrefix = `channels.${sourceChannelId}`;
  if (value === sourcePrefix) {
    return `channels.${targetChannelId}`;
  }
  if (value.startsWith(`${sourcePrefix}.`)) {
    return `channels.${targetChannelId}${value.slice(sourcePrefix.length)}`;
  }
  return value;
}

function normalizeManifestText(value: string | undefined, fallback: string): string {
  return sanitizeForLog(value?.trim() || fallback).trim();
}

function rebindChannelConfig(
  cfg: OpenClawConfig,
  sourceChannelId: string,
  targetChannelId: string,
): OpenClawConfig {
  if (sourceChannelId === targetChannelId || !cfg.channels) {
    return cfg;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [sourceChannelId]: (cfg.channels as Record<string, unknown>)[targetChannelId],
    },
  };
}

function restoreReboundChannelConfig(params: {
  original: OpenClawConfig;
  updated: OpenClawConfig;
  sourceChannelId: string;
  targetChannelId: string;
}): OpenClawConfig {
  if (params.sourceChannelId === params.targetChannelId || !params.updated.channels) {
    return params.updated;
  }
  const nextChannels = { ...params.updated.channels };
  if (Object.prototype.hasOwnProperty.call(nextChannels, params.sourceChannelId)) {
    nextChannels[params.targetChannelId] = nextChannels[params.sourceChannelId];
  } else {
    delete nextChannels[params.targetChannelId];
  }
  if (
    params.original.channels &&
    Object.prototype.hasOwnProperty.call(params.original.channels, params.sourceChannelId)
  ) {
    nextChannels[params.sourceChannelId] = params.original.channels[params.sourceChannelId];
  } else {
    delete nextChannels[params.sourceChannelId];
  }
  return {
    ...params.updated,
    channels: nextChannels,
  };
}

function getChannelConfigRecord(cfg: OpenClawConfig, channelId: string): Record<string, unknown> {
  if (!isSafeManifestChannelId(channelId)) {
    return {};
  }
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return {};
  }
  const entry = readOwnRecordValue(channels as Record<string, unknown>, channelId);
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : {};
}

function listManifestChannelAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const channelConfig = getChannelConfigRecord(cfg, channelId);
  const accounts = channelConfig.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    return [
      ...new Set(
        Object.keys(accounts)
          .filter((accountId) => !isBlockedObjectKey(accountId))
          .map((accountId) => normalizeAccountId(accountId))
          .filter((accountId) => !isBlockedObjectKey(accountId)),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
  }
  return hasExplicitChannelConfig({ config: cfg, channelId }) ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveManifestChannelAccountConfig(params: {
  cfg: OpenClawConfig;
  channelId: string;
  accountId?: string | null;
}): Record<string, unknown> {
  const channelConfig = getChannelConfigRecord(params.cfg, params.channelId);
  const resolvedAccountId = normalizeAccountId(params.accountId);
  const accounts = channelConfig.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    const accountConfig = readOwnRecordValue(
      accounts as Record<string, unknown>,
      resolvedAccountId,
    );
    if (accountConfig && typeof accountConfig === "object" && !Array.isArray(accountConfig)) {
      return accountConfig as Record<string, unknown>;
    }
  }
  return channelConfig;
}

function buildManifestChannelPlugin(params: {
  record: PluginManifestRecord;
  channelId: string;
}): ChannelPlugin | undefined {
  if (!isSafeManifestChannelId(params.channelId)) {
    return undefined;
  }
  const catalogMeta =
    params.record.channelCatalogMeta?.id === params.channelId
      ? params.record.channelCatalogMeta
      : undefined;
  const channelConfigValue = params.record.channelConfigs
    ? readOwnRecordValue(params.record.channelConfigs as Record<string, unknown>, params.channelId)
    : undefined;
  if (
    !catalogMeta &&
    (!channelConfigValue ||
      typeof channelConfigValue !== "object" ||
      Array.isArray(channelConfigValue)) &&
    !params.record.channels.includes(params.channelId)
  ) {
    return undefined;
  }
  const channelConfig =
    channelConfigValue &&
    typeof channelConfigValue === "object" &&
    !Array.isArray(channelConfigValue)
      ? (channelConfigValue as ManifestChannelConfigRecord)
      : undefined;
  const label =
    normalizeManifestText(
      channelConfig?.label ?? catalogMeta?.label,
      params.record.name || params.channelId,
    ) || params.channelId;
  const blurb = normalizeManifestText(
    channelConfig?.description ?? catalogMeta?.blurb,
    params.record.description || "",
  );
  const commands = normalizeChannelCommandDefaults(
    channelConfig?.commands ?? catalogMeta?.commands,
  );
  return {
    id: params.channelId,
    meta: {
      id: params.channelId,
      label,
      selectionLabel: label,
      docsPath: `/channels/${encodeURIComponent(params.channelId)}`,
      blurb,
      ...(channelConfig?.preferOver?.length
        ? { preferOver: channelConfig.preferOver }
        : catalogMeta?.preferOver?.length
          ? { preferOver: catalogMeta.preferOver }
          : {}),
    },
    capabilities: { chatTypes: ["direct"] },
    ...(commands ? { commands } : {}),
    ...(channelConfig
      ? {
          configSchema: {
            schema: channelConfig.schema,
            ...(channelConfig.uiHints ? { uiHints: channelConfig.uiHints } : {}),
            ...(channelConfig.runtime ? { runtime: channelConfig.runtime } : {}),
          },
        }
      : {}),
    config: {
      listAccountIds: (cfg) => listManifestChannelAccountIds(cfg, params.channelId),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      resolveAccount: (cfg, accountId) => ({
        accountId: normalizeAccountId(accountId),
        config: resolveManifestChannelAccountConfig({
          cfg,
          channelId: params.channelId,
          accountId,
        }),
      }),
      isEnabled: (_account, cfg) => getChannelConfigRecord(cfg, params.channelId).enabled !== false,
      isConfigured: (_account, cfg) =>
        hasExplicitChannelConfig({
          config: cfg,
          channelId: params.channelId,
        }),
      hasConfiguredState: ({ cfg }) =>
        hasExplicitChannelConfig({
          config: cfg,
          channelId: params.channelId,
        }),
    },
  };
}

function canUseManifestChannelPlugin(record: PluginManifestRecord, channelId: string): boolean {
  const hasChannelConfig = Boolean(
    record.channelConfigs && Object.prototype.hasOwnProperty.call(record.channelConfigs, channelId),
  );
  if (hasChannelConfig) {
    return record.setup?.requiresRuntime === false || !record.setupSource;
  }
  return record.channelCatalogMeta?.id === channelId || !record.setupSource;
}

export { resolveReadOnlyChannelCommandDefaults };

function loadSetupChannelPluginFromManifestRecord(params: {
  record: PluginManifestRecord;
  channelId: string;
}): { plugin?: ChannelPlugin; failure?: ReadOnlyChannelPluginLoadFailure } {
  if (!params.record.setupSource || !params.record.channels.includes(params.channelId)) {
    return {};
  }
  try {
    const moduleLoader = getCachedPluginModuleLoader({
      cache: moduleLoaders,
      modulePath: params.record.setupSource,
      importerUrl: import.meta.url,
      preferBuiltDist: true,
      loaderFilename: import.meta.url,
      tryNative: true,
      cacheScopeKey: "read-only-setup-entry",
    });
    const registration = resolveSetupChannelRegistration(moduleLoader(params.record.setupSource));
    if (registration.loadError) {
      return {
        failure: {
          channelId: params.channelId,
          pluginId: params.record.id,
          source: params.record.setupSource,
          message: `failed to load setup entry: ${formatErrorMessage(registration.loadError)}`,
        },
      };
    }
    if (!registration.plugin) {
      return {};
    }
    if (
      !channelPluginIdBelongsToManifest({
        channelId: registration.plugin.id,
        pluginId: params.record.id,
        manifestChannels: params.record.channels,
      })
    ) {
      return {};
    }
    return { plugin: cloneChannelPluginForChannelId(registration.plugin, params.channelId) };
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load channel setup ${params.record.id}: ${detail}`);
    return {
      failure: {
        channelId: params.channelId,
        pluginId: params.record.id,
        source: params.record.setupSource,
        message: `failed to load setup entry: ${detail}`,
      },
    };
  }
}

function collectChannelPluginLoadFailuresFromDiagnostics(params: {
  diagnostics: readonly PluginDiagnostic[] | undefined;
  records: readonly PluginManifestRecord[];
  channelIds: readonly string[];
}): ReadOnlyChannelPluginLoadFailure[] {
  if (!params.diagnostics?.length || params.channelIds.length === 0) {
    return [];
  }
  const configuredChannelIds = new Set(params.channelIds);
  const recordsByPluginId = new Map(params.records.map((record) => [record.id, record] as const));
  const failures: ReadOnlyChannelPluginLoadFailure[] = [];
  for (const diagnostic of params.diagnostics) {
    if (diagnostic.level !== "error" || !diagnostic.pluginId) {
      continue;
    }
    const record = recordsByPluginId.get(diagnostic.pluginId);
    if (!record) {
      continue;
    }
    for (const channelId of record.channels) {
      if (!configuredChannelIds.has(channelId)) {
        continue;
      }
      failures.push({
        channelId,
        pluginId: record.id,
        source: diagnostic.source,
        message: diagnostic.message,
      });
    }
  }
  return failures;
}

function rebindChannelPluginConfig(
  config: ChannelPlugin["config"],
  sourceChannelId: string,
  targetChannelId: string,
): ChannelPlugin["config"] {
  const rebind = (cfg: OpenClawConfig) =>
    rebindChannelConfig(cfg, sourceChannelId, targetChannelId);
  return {
    ...config,
    listAccountIds: (cfg) => config.listAccountIds(rebind(cfg)),
    resolveAccount: (cfg, accountId) => config.resolveAccount(rebind(cfg), accountId),
    inspectAccount: config.inspectAccount
      ? (cfg, accountId) => config.inspectAccount?.(rebind(cfg), accountId)
      : undefined,
    defaultAccountId: config.defaultAccountId
      ? (cfg) => config.defaultAccountId?.(rebind(cfg)) ?? ""
      : undefined,
    setAccountEnabled: config.setAccountEnabled
      ? (params) =>
          restoreReboundChannelConfig({
            original: params.cfg,
            updated:
              config.setAccountEnabled?.({ ...params, cfg: rebind(params.cfg) }) ?? params.cfg,
            sourceChannelId,
            targetChannelId,
          })
      : undefined,
    deleteAccount: config.deleteAccount
      ? (params) =>
          restoreReboundChannelConfig({
            original: params.cfg,
            updated: config.deleteAccount?.({ ...params, cfg: rebind(params.cfg) }) ?? params.cfg,
            sourceChannelId,
            targetChannelId,
          })
      : undefined,
    isEnabled: config.isEnabled
      ? (account, cfg) => config.isEnabled?.(account, rebind(cfg)) ?? false
      : undefined,
    disabledReason: config.disabledReason
      ? (account, cfg) => config.disabledReason?.(account, rebind(cfg)) ?? ""
      : undefined,
    isConfigured: config.isConfigured
      ? (account, cfg) => config.isConfigured?.(account, rebind(cfg)) ?? false
      : undefined,
    unconfiguredReason: config.unconfiguredReason
      ? (account, cfg) => config.unconfiguredReason?.(account, rebind(cfg)) ?? ""
      : undefined,
    describeAccount: config.describeAccount
      ? (account, cfg) => config.describeAccount!(account, rebind(cfg))
      : undefined,
    resolveAllowFrom: config.resolveAllowFrom
      ? (params) => config.resolveAllowFrom?.({ ...params, cfg: rebind(params.cfg) })
      : undefined,
    formatAllowFrom: config.formatAllowFrom
      ? (params) => config.formatAllowFrom?.({ ...params, cfg: rebind(params.cfg) }) ?? []
      : undefined,
    hasConfiguredState: config.hasConfiguredState
      ? (params) => config.hasConfiguredState?.({ ...params, cfg: rebind(params.cfg) }) ?? false
      : undefined,
    hasPersistedAuthState: config.hasPersistedAuthState
      ? (params) => config.hasPersistedAuthState?.({ ...params, cfg: rebind(params.cfg) }) ?? false
      : undefined,
    resolveDefaultTo: config.resolveDefaultTo
      ? (params) => config.resolveDefaultTo?.({ ...params, cfg: rebind(params.cfg) })
      : undefined,
  };
}

function rebindChannelPluginSecrets(
  secrets: ChannelPlugin["secrets"],
  sourceChannelId: string,
  targetChannelId: string,
): ChannelPlugin["secrets"] {
  if (!secrets) {
    return undefined;
  }
  return {
    ...secrets,
    secretTargetRegistryEntries: secrets.secretTargetRegistryEntries?.map((entry) => ({
      ...entry,
      id: rebindChannelScopedString(entry.id, sourceChannelId, targetChannelId),
      pathPattern: rebindChannelScopedString(entry.pathPattern, sourceChannelId, targetChannelId),
      ...(entry.refPathPattern
        ? {
            refPathPattern: rebindChannelScopedString(
              entry.refPathPattern,
              sourceChannelId,
              targetChannelId,
            ),
          }
        : {}),
    })),
    unsupportedSecretRefSurfacePatterns: secrets.unsupportedSecretRefSurfacePatterns?.map(
      (pattern) => rebindChannelScopedString(pattern, sourceChannelId, targetChannelId),
    ),
    collectRuntimeConfigAssignments: secrets.collectRuntimeConfigAssignments
      ? (params) =>
          secrets.collectRuntimeConfigAssignments?.({
            ...params,
            config: rebindChannelConfig(params.config, sourceChannelId, targetChannelId),
          })
      : undefined,
  };
}

function cloneChannelPluginForChannelId(plugin: ChannelPlugin, channelId: string): ChannelPlugin {
  if (plugin.id === channelId && plugin.meta.id === channelId) {
    return plugin;
  }
  const sourceChannelId = plugin.id;
  return {
    ...plugin,
    id: channelId,
    meta: {
      ...plugin.meta,
      id: channelId,
    },
    config: rebindChannelPluginConfig(plugin.config, sourceChannelId, channelId),
    secrets: rebindChannelPluginSecrets(plugin.secrets, sourceChannelId, channelId),
  };
}

function addSetupChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  setups: Iterable<{
    pluginId: string;
    plugin: ChannelPlugin;
  }>,
  options: {
    ownedChannelIdsByPluginId: ReadonlyMap<string, readonly string[]>;
    ownedMissingChannelIdsByPluginId: ReadonlyMap<string, readonly string[]>;
  },
): void {
  for (const setup of setups) {
    const ownedMissingChannelIds = options.ownedMissingChannelIdsByPluginId
      .get(setup.pluginId)
      ?.filter(isSafeManifestChannelId);
    if (!ownedMissingChannelIds || ownedMissingChannelIds.length === 0) {
      continue;
    }
    if (ownedMissingChannelIds.includes(setup.plugin.id)) {
      addChannelPlugins(byId, [setup.plugin], {
        onlyIds: new Set(ownedMissingChannelIds),
        allowOverwrite: false,
      });
      addChannelPlugins(
        byId,
        ownedMissingChannelIds
          .filter((channelId) => channelId !== setup.plugin.id)
          .map((channelId) => cloneChannelPluginForChannelId(setup.plugin, channelId)),
        {
          onlyIds: new Set(ownedMissingChannelIds),
          allowOverwrite: false,
        },
      );
      continue;
    }
    const ownedChannelIds = (options.ownedChannelIdsByPluginId.get(setup.pluginId) ?? []).filter(
      isSafeManifestChannelId,
    );
    if (setup.plugin.id !== setup.pluginId && !ownedChannelIds.includes(setup.plugin.id)) {
      continue;
    }
    addChannelPlugins(
      byId,
      ownedMissingChannelIds.map((channelId) =>
        cloneChannelPluginForChannelId(setup.plugin, channelId),
      ),
      {
        onlyIds: new Set(ownedMissingChannelIds),
        allowOverwrite: false,
      },
    );
  }
}

function addManifestChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  records: readonly PluginManifestRecord[],
  options: {
    pluginIds: ReadonlySet<string>;
    channelIds: readonly string[];
  },
): void {
  const channelIds = new Set(options.channelIds);
  for (const record of records) {
    if (!options.pluginIds.has(record.id)) {
      continue;
    }
    for (const channelId of record.channels) {
      if (!isSafeManifestChannelId(channelId)) {
        continue;
      }
      if (!channelIds.has(channelId)) {
        continue;
      }
      if (!canUseManifestChannelPlugin(record, channelId)) {
        continue;
      }
      addChannelPlugins(byId, [buildManifestChannelPlugin({ record, channelId })], {
        onlyIds: channelIds,
        allowOverwrite: false,
      });
    }
  }
}

function resolveReadOnlyWorkspaceDir(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions,
): string | undefined {
  return options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function listExternalChannelManifestRecords(
  records: readonly PluginManifestRecord[],
): PluginManifestRecord[] {
  return records.filter((plugin) => plugin.origin !== "bundled" && plugin.channels.length > 0);
}

function listBundledChannelManifestRecords(
  records: readonly PluginManifestRecord[],
): PluginManifestRecord[] {
  return records.filter((plugin) => plugin.origin === "bundled" && plugin.channels.length > 0);
}

function listPluginIdsForChannels(
  records: readonly PluginManifestRecord[],
  channelIds: readonly string[],
): string[] {
  const requestedChannelIds = new Set(channelIds);
  return records
    .filter((plugin) => plugin.channels.some((channelId) => requestedChannelIds.has(channelId)))
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveExternalReadOnlyChannelPluginIds(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  records: readonly PluginManifestRecord[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  if (params.channelIds.length === 0) {
    return [];
  }
  const candidatePluginIds = resolveDiscoverableScopedChannelPluginIds({
    config: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    channelIds: params.channelIds,
    workspaceDir: params.workspaceDir,
    env: params.env,
    manifestRecords: params.records,
  });
  if (candidatePluginIds.length === 0) {
    return [];
  }

  const requestedChannelIds = new Set(params.channelIds);
  const candidatePluginIdSet = new Set(candidatePluginIds);
  return params.records
    .filter(
      (plugin) =>
        candidatePluginIdSet.has(plugin.id) &&
        plugin.channels.some((channelId) => requestedChannelIds.has(channelId)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  options?: ReadOnlyChannelPluginOptions,
): ChannelPlugin[] {
  return resolveReadOnlyChannelPluginsForConfig(cfg, options).plugins;
}

export function resolveReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions = {},
): ReadOnlyChannelPluginResolution {
  const env = options.env ?? process.env;
  const workspaceDir = resolveReadOnlyWorkspaceDir(cfg, options);
  const metadataSnapshot =
    options.stateDir === undefined
      ? getCurrentPluginMetadataSnapshot({
          config: cfg,
          env,
          workspaceDir,
        })
      : undefined;
  const manifestRecords =
    metadataSnapshot?.plugins ??
    loadPluginMetadataSnapshot({
      config: cfg,
      stateDir: options.stateDir,
      workspaceDir,
      env,
    }).plugins;
  const bundledManifestRecords = listBundledChannelManifestRecords(manifestRecords);
  const externalManifestRecords = listExternalChannelManifestRecords(manifestRecords);
  const configuredChannelIds = [
    ...new Set(
      listConfiguredChannelIdsForReadOnlyScope({
        config: cfg,
        activationSourceConfig: options.activationSourceConfig ?? cfg,
        workspaceDir,
        env,
        includePersistedAuthState: options.includePersistedAuthState,
        manifestRecords,
      }),
    ),
  ].filter(isSafeManifestChannelId);
  const byId = new Map<string, ChannelPlugin>();
  const loadFailures: ReadOnlyChannelPluginLoadFailure[] = [];

  addChannelPlugins(byId, listChannelPlugins());

  if (options.includeSetupFallbackPlugins === true) {
    for (const channelId of configuredChannelIds) {
      if (byId.has(channelId)) {
        continue;
      }
      const setupResults = bundledManifestRecords
        .filter((record) => record.channels.includes(channelId))
        .map((record) =>
          loadSetupChannelPluginFromManifestRecord({
            record,
            channelId,
          }),
        );
      loadFailures.push(
        ...setupResults
          .map((result) => result.failure)
          .filter((failure): failure is ReadOnlyChannelPluginLoadFailure => Boolean(failure)),
      );
      const bundledSetupPlugin =
        setupResults.map((result) => result.plugin).find((plugin) => plugin) ??
        getBundledChannelSetupPlugin(channelId, env);
      addChannelPlugins(byId, [bundledSetupPlugin]);
    }
  }

  const bundledManifestMissingChannelIds = configuredChannelIds.filter(
    (channelId) => !byId.has(channelId),
  );
  addManifestChannelPlugins(byId, bundledManifestRecords, {
    pluginIds: new Set(
      listPluginIdsForChannels(bundledManifestRecords, bundledManifestMissingChannelIds),
    ),
    channelIds: bundledManifestMissingChannelIds,
  });

  const missingConfiguredChannelIds = configuredChannelIds.filter(
    (channelId) => !byId.has(channelId),
  );
  const externalPluginIds = resolveExternalReadOnlyChannelPluginIds({
    cfg,
    activationSourceConfig: options.activationSourceConfig ?? cfg,
    channelIds: missingConfiguredChannelIds,
    records: externalManifestRecords,
    workspaceDir,
    env,
  });
  if (externalPluginIds.length > 0) {
    const externalPluginIdSet = new Set(externalPluginIds);
    const ownedChannelIdsByPluginId = new Map(
      externalManifestRecords
        .filter((record) => externalPluginIdSet.has(record.id))
        .map((record) => [record.id, record.channels] as const),
    );
    if (missingConfiguredChannelIds.length > 0 && options.includeSetupFallbackPlugins === true) {
      const missingChannelIdSet = new Set(missingConfiguredChannelIds);
      const ownedMissingChannelIdsByPluginId = new Map(
        [...ownedChannelIdsByPluginId].map(
          ([pluginId, channelIds]) =>
            [
              pluginId,
              channelIds.filter((channelId) => missingChannelIdSet.has(channelId)),
            ] as const,
        ),
      );
      const registry = loadPluginLoaderModule().loadOpenClawPlugins({
        config: cfg,
        activationSourceConfig: options.activationSourceConfig ?? cfg,
        env,
        workspaceDir,
        cache: false,
        activate: false,
        includeSetupOnlyChannelPlugins: true,
        forceSetupOnlyChannelPlugins: true,
        requireSetupEntryForSetupOnlyChannelPlugins: true,
        onlyPluginIds: externalPluginIds,
      });
      loadFailures.push(
        ...collectChannelPluginLoadFailuresFromDiagnostics({
          diagnostics: registry.diagnostics,
          records: externalManifestRecords,
          channelIds: missingConfiguredChannelIds,
        }),
      );
      addSetupChannelPlugins(byId, registry.channelSetups, {
        ownedChannelIdsByPluginId,
        ownedMissingChannelIdsByPluginId,
      });
    }
    const externalManifestMissingChannelIds = missingConfiguredChannelIds.filter(
      (channelId) => !byId.has(channelId),
    );
    addManifestChannelPlugins(byId, externalManifestRecords, {
      pluginIds: externalPluginIdSet,
      channelIds: externalManifestMissingChannelIds,
    });
  }

  const plugins = [...byId.values()];
  return {
    plugins,
    configuredChannelIds,
    missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
    loadFailures,
  };
}
