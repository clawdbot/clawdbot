import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listConfiguredChannelIdsForReadOnlyScope,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

type ReadOnlyChannelPluginOptions = {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  activationSourceConfig?: OpenClawConfig;
  includePersistedAuthState?: boolean;
  cache?: boolean;
};

type ReadOnlyChannelPluginResolution = {
  plugins: ChannelPlugin[];
  configuredChannelIds: string[];
  missingConfiguredChannelIds: string[];
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
    const ownedMissingChannelIds = options.ownedMissingChannelIdsByPluginId.get(setup.pluginId);
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
    const ownedChannelIds = options.ownedChannelIdsByPluginId.get(setup.pluginId) ?? [];
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

function resolveReadOnlyWorkspaceDir(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions,
): string | undefined {
  return options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function listExternalChannelManifestRecords(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): PluginManifestRecord[] {
  return loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  }).plugins.filter((plugin) => plugin.origin !== "bundled" && plugin.channels.length > 0);
}

function resolveExternalReadOnlyChannelPluginIds(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  records: readonly PluginManifestRecord[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
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
    cache: params.cache,
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
  const externalManifestRecords = listExternalChannelManifestRecords({
    cfg,
    workspaceDir,
    env,
    cache: options.cache,
  });
  const configuredChannelIds = [
    ...new Set(
      listConfiguredChannelIdsForReadOnlyScope({
        config: cfg,
        activationSourceConfig: options.activationSourceConfig ?? cfg,
        workspaceDir,
        env,
        cache: options.cache,
        includePersistedAuthState: options.includePersistedAuthState,
        manifestRecords: externalManifestRecords,
      }),
    ),
  ];
  const byId = new Map<string, ChannelPlugin>();

  addChannelPlugins(byId, listChannelPlugins());

  for (const channelId of configuredChannelIds) {
    if (byId.has(channelId)) {
      continue;
    }
    addChannelPlugins(byId, [getBundledChannelSetupPlugin(channelId)]);
  }

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
    cache: options.cache,
  });
  if (externalPluginIds.length > 0) {
    const missingChannelIdSet = new Set(missingConfiguredChannelIds);
    const externalPluginIdSet = new Set(externalPluginIds);
    const ownedChannelIdsByPluginId = new Map(
      externalManifestRecords
        .filter((record) => externalPluginIdSet.has(record.id))
        .map((record) => [record.id, record.channels] as const),
    );
    const ownedMissingChannelIdsByPluginId = new Map(
      [...ownedChannelIdsByPluginId].map(
        ([pluginId, channelIds]) =>
          [pluginId, channelIds.filter((channelId) => missingChannelIdSet.has(channelId))] as const,
      ),
    );
    const registry = loadOpenClawPlugins({
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
    addSetupChannelPlugins(byId, registry.channelSetups, {
      ownedChannelIdsByPluginId,
      ownedMissingChannelIdsByPluginId,
    });
  }

  const plugins = [...byId.values()];
  return {
    plugins,
    configuredChannelIds,
    missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
  };
}
