/**
 * Read-only channel plugin discovery.
 *
 * Builds lightweight channel plugin views from config, manifests, and setup metadata.
 */
import {
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { tryResolveConfiguredAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveConfigWidePluginManifestRegistry } from "../../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  hasExplicitChannelConfig,
  listConfiguredChannelIdsForReadOnlyScope,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "../../plugins/loader-channel-setup.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { getPluginCache } from "../../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getCachedPluginModuleLoader } from "../../plugins/plugin-module-loader-cache.js";
import { resolveNormalizedAccountEntry } from "../../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import { resolveListedDefaultAccountId } from "./account-helpers.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import type { ManifestChannelPlugin } from "./manifest-channel-plugin.types.js";
import {
  isSafeManifestChannelId,
  normalizeChannelCommandDefaults,
  readOwnRecordValue,
  resolveReadOnlyChannelCommandDefaults,
} from "./read-only-command-defaults.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

const log = createSubsystemLogger("channels");

type ReadOnlyChannelPluginOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  activationSourceConfig?: OpenClawConfig;
  includePersistedAuthState?: boolean;
  includeSetupFallbackPlugins?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
};

type ReadOnlyChannelPluginResolution = {
  plugins: ChannelPlugin[];
  manifestRecords: readonly PluginManifestRecord[];
  configuredChannelIds: string[];
  missingConfiguredChannelIds: string[];
  loadFailures: ReadOnlyChannelPluginLoadFailure[];
};
type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];
type ReadOnlyChannelPluginLoadFailure = {
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
      [sourceChannelId]: cfg.channels[targetChannelId],
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
  if (Object.hasOwn(nextChannels, params.sourceChannelId)) {
    nextChannels[params.targetChannelId] = nextChannels[params.sourceChannelId];
  } else {
    delete nextChannels[params.targetChannelId];
  }
  if (params.original.channels && Object.hasOwn(params.original.channels, params.sourceChannelId)) {
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

function normalizeManifestAccountConfigKey(accountId: string): string {
  return normalizeOptionalAccountId(accountId) ?? "";
}

function listManifestChannelAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const channelConfig = getChannelConfigRecord(cfg, channelId);
  const accounts = channelConfig.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    return sortUniqueStrings(
      Object.keys(accounts)
        .filter((accountId) => !isBlockedObjectKey(accountId))
        .map((accountId) => normalizeOptionalAccountId(accountId))
        .filter((accountId): accountId is string => Boolean(accountId)),
    );
  }
  return hasExplicitChannelConfig({ config: cfg, channelId }) ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveManifestChannelDefaultAccountId(cfg: OpenClawConfig, channelId: string): string {
  const channelConfig = getChannelConfigRecord(cfg, channelId);
  const configuredDefaultAccountId = normalizeOptionalAccountId(
    typeof channelConfig.defaultAccount === "string" ? channelConfig.defaultAccount : undefined,
  );
  return resolveListedDefaultAccountId({
    accountIds: listManifestChannelAccountIds(cfg, channelId),
    configuredDefaultAccountId,
  });
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
    const accountConfig = resolveNormalizedAccountEntry(
      accounts as Record<string, unknown>,
      resolvedAccountId,
      normalizeManifestAccountConfigKey,
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
  // Only the adapter is static; its methods receive current account config and
  // channel selection still reevaluates policy, environment, and persisted auth.
  const adapters = getPluginCache().metadata.channelAdapters;
  let channels = adapters.get(params.record);
  if (!channels) {
    channels = new Map();
    adapters.set(params.record, channels);
  }
  if (!channels.has(params.channelId)) {
    channels.set(params.channelId, createManifestChannelPlugin(params));
  }
  return channels.get(params.channelId);
}

function createManifestChannelPlugin(params: {
  record: PluginManifestRecord;
  channelId: string;
}): ManifestChannelPlugin | undefined {
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
      defaultAccountId: (cfg) => resolveManifestChannelDefaultAccountId(cfg, params.channelId),
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
    record.channelConfigs && Object.hasOwn(record.channelConfigs, channelId),
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
  const adapters = getPluginCache().metadata.channelSetupAdapters;
  const cached = adapters.get(params.record);
  if (cached) {
    return { plugin: cached };
  }
  try {
    const moduleLoader = getCachedPluginModuleLoader({
      modulePath: params.record.setupSource,
      rootDir: params.record.rootDir,
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
    // Factories may import lazy setup dependencies; retain successful adapters
    // in this cache generation while their account methods keep reading live config.
    adapters.set(params.record, registration.plugin);
    return { plugin: registration.plugin };
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
    isLinked: config.isLinked
      ? (account, cfg) => config.isLinked?.(account, rebind(cfg)) ?? "unknown"
      : undefined,
    unconfiguredReason: config.unconfiguredReason
      ? (account, cfg) => config.unconfiguredReason?.(account, rebind(cfg)) ?? ""
      : undefined,
    unlinkedReason: config.unlinkedReason
      ? (account, cfg) => config.unlinkedReason?.(account, rebind(cfg)) ?? ""
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

function addManifestChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  records: readonly PluginManifestRecord[],
  options: {
    pluginIds: ReadonlySet<string>;
    channelIds: readonly string[];
    includeSetupFallbackPlugins: boolean;
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
      // Inventory can describe accounts without executing setup. Setup-backed callers
      // must still see missing capabilities when a runtime-dependent setup fails.
      if (options.includeSetupFallbackPlugins && !canUseManifestChannelPlugin(record, channelId)) {
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
  return options.workspaceDir ?? tryResolveConfiguredAgentWorkspaceDir(cfg, options.env);
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
  const includeSetupFallbackPlugins = options.includeSetupFallbackPlugins === true;
  const loadedChannelPlugins = listChannelPlugins();
  const manifestRecords =
    options.metadataSnapshot?.plugins ??
    (options.workspaceDir !== undefined
      ? resolvePluginMetadataSnapshot({
          config: cfg,
          stateDir: options.stateDir,
          workspaceDir: options.workspaceDir,
          env,
          allowWorkspaceScopedCurrent: true,
        }).plugins
      : resolveConfigWidePluginManifestRegistry({
          config: cfg,
          stateDir: options.stateDir,
          env,
        }).plugins);
  const bundledManifestRecords = listBundledChannelManifestRecords(manifestRecords);
  const externalManifestRecords = listExternalChannelManifestRecords(manifestRecords);
  const activationSourceConfig = options.activationSourceConfig ?? cfg;
  const configuredChannelIds = uniqueStrings([
    ...listConfiguredChannelIdsForReadOnlyScope({
      config: cfg,
      activationSourceConfig,
      workspaceDir,
      env,
      includePersistedAuthState: options.includePersistedAuthState,
      manifestRecords,
    }),
    ...(activationSourceConfig === cfg
      ? []
      : listConfiguredChannelIdsForReadOnlyScope({
          config: activationSourceConfig,
          activationSourceConfig,
          workspaceDir,
          env,
          includePersistedAuthState: options.includePersistedAuthState,
          manifestRecords,
        })),
  ]).filter(isSafeManifestChannelId);
  const byId = new Map<string, ChannelPlugin>();
  const loadFailures: ReadOnlyChannelPluginLoadFailure[] = [];

  addChannelPlugins(byId, loadedChannelPlugins);

  if (includeSetupFallbackPlugins) {
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
      addChannelPlugins(byId, [
        bundledSetupPlugin && cloneChannelPluginForChannelId(bundledSetupPlugin, channelId),
      ]);
    }
  }

  const bundledManifestMissingChannelIds = configuredChannelIds.filter(
    (channelId) => !byId.has(channelId),
  );
  const bundledManifestMissingChannelIdSet = new Set(bundledManifestMissingChannelIds);
  addManifestChannelPlugins(byId, bundledManifestRecords, {
    pluginIds: new Set(
      bundledManifestRecords.flatMap((record) =>
        record.channels.some((channelId) => bundledManifestMissingChannelIdSet.has(channelId))
          ? [record.id]
          : [],
      ),
    ),
    channelIds: bundledManifestMissingChannelIds,
    includeSetupFallbackPlugins,
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
    if (includeSetupFallbackPlugins) {
      const missingChannelIdSet = new Set(missingConfiguredChannelIds);
      for (const record of externalManifestRecords) {
        if (!externalPluginIdSet.has(record.id) || !record.setupSource) {
          continue;
        }
        const ownedMissingChannelIds = record.channels.filter(
          (channelId) => missingChannelIdSet.has(channelId) && !byId.has(channelId),
        );
        const firstChannelId = ownedMissingChannelIds[0];
        if (!firstChannelId) {
          continue;
        }
        const setupResult = loadSetupChannelPluginFromManifestRecord({
          record,
          channelId: firstChannelId,
        });
        const failure = setupResult.failure;
        if (failure) {
          loadFailures.push(
            ...ownedMissingChannelIds.map((channelId) => ({ ...failure, channelId })),
          );
          continue;
        }
        const plugin = setupResult.plugin;
        if (plugin) {
          addChannelPlugins(
            byId,
            ownedMissingChannelIds.map((channelId) =>
              cloneChannelPluginForChannelId(plugin, channelId),
            ),
            { allowOverwrite: false },
          );
        }
      }
    }
    const externalManifestMissingChannelIds = missingConfiguredChannelIds.filter(
      (channelId) => !byId.has(channelId),
    );
    addManifestChannelPlugins(byId, externalManifestRecords, {
      pluginIds: externalPluginIdSet,
      channelIds: externalManifestMissingChannelIds,
      includeSetupFallbackPlugins,
    });
  }

  const plugins = [...byId.values()];
  return {
    plugins,
    manifestRecords,
    configuredChannelIds,
    missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
    loadFailures,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
