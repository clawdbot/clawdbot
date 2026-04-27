import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveChannelPluginIdsFromRegistry,
  resolveConfiguredDeferredChannelPluginIdsFromRegistry,
  resolveGatewayStartupPluginIdsFromRegistry,
} from "./channel-plugin-ids.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { createPluginRegistryIdNormalizer } from "./plugin-registry-contributions.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  type PluginRegistrySnapshot,
  type PluginRegistrySnapshotDiagnostic,
} from "./plugin-registry-snapshot.js";

export type PluginLookUpTableOwnerMaps = {
  channels: ReadonlyMap<string, readonly string[]>;
  channelConfigs: ReadonlyMap<string, readonly string[]>;
  providers: ReadonlyMap<string, readonly string[]>;
  modelCatalogProviders: ReadonlyMap<string, readonly string[]>;
  cliBackends: ReadonlyMap<string, readonly string[]>;
  setupProviders: ReadonlyMap<string, readonly string[]>;
  commandAliases: ReadonlyMap<string, readonly string[]>;
  contracts: ReadonlyMap<string, readonly string[]>;
};

export type PluginLookUpTableStartupPlan = {
  channelPluginIds: readonly string[];
  configuredDeferredChannelPluginIds: readonly string[];
  pluginIds: readonly string[];
};

export type PluginLookUpTableMetrics = {
  registrySnapshotMs: number;
  manifestRegistryMs: number;
  startupPlanMs: number;
  ownerMapsMs: number;
  totalMs: number;
  indexPluginCount: number;
  manifestPluginCount: number;
  startupPluginCount: number;
  deferredChannelPluginCount: number;
};

export type PluginLookUpTable = {
  key: string;
  index: PluginRegistrySnapshot;
  registryDiagnostics: readonly PluginRegistrySnapshotDiagnostic[];
  manifestRegistry: PluginManifestRegistry;
  plugins: readonly PluginManifestRecord[];
  diagnostics: readonly PluginDiagnostic[];
  byPluginId: ReadonlyMap<string, PluginManifestRecord>;
  normalizePluginId: (pluginId: string) => string;
  owners: PluginLookUpTableOwnerMaps;
  startup: PluginLookUpTableStartupPlan;
  metrics: PluginLookUpTableMetrics;
};

export type LoadPluginLookUpTableParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
};

function appendOwner(owners: Map<string, string[]>, ownedId: string, pluginId: string): void {
  const existing = owners.get(ownedId);
  if (existing) {
    existing.push(pluginId);
    return;
  }
  owners.set(ownedId, [pluginId]);
}

function freezeOwnerMap(owners: Map<string, string[]>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...owners.entries()].map(([ownedId, pluginIds]) => [ownedId, Object.freeze([...pluginIds])]),
  );
}

function buildOwnerMaps(plugins: readonly PluginManifestRecord[]): PluginLookUpTableOwnerMaps {
  const channels = new Map<string, string[]>();
  const channelConfigs = new Map<string, string[]>();
  const providers = new Map<string, string[]>();
  const modelCatalogProviders = new Map<string, string[]>();
  const cliBackends = new Map<string, string[]>();
  const setupProviders = new Map<string, string[]>();
  const commandAliases = new Map<string, string[]>();
  const contracts = new Map<string, string[]>();

  for (const plugin of plugins) {
    for (const channelId of plugin.channels) {
      appendOwner(channels, channelId, plugin.id);
    }
    for (const channelId of Object.keys(plugin.channelConfigs ?? {})) {
      appendOwner(channelConfigs, channelId, plugin.id);
    }
    for (const providerId of plugin.providers) {
      appendOwner(providers, providerId, plugin.id);
    }
    for (const providerId of Object.keys(plugin.modelCatalog?.providers ?? {})) {
      appendOwner(modelCatalogProviders, providerId, plugin.id);
    }
    for (const cliBackendId of plugin.cliBackends) {
      appendOwner(cliBackends, cliBackendId, plugin.id);
    }
    for (const cliBackendId of plugin.setup?.cliBackends ?? []) {
      appendOwner(cliBackends, cliBackendId, plugin.id);
    }
    for (const setupProvider of plugin.setup?.providers ?? []) {
      appendOwner(setupProviders, setupProvider.id, plugin.id);
    }
    for (const commandAlias of plugin.commandAliases ?? []) {
      appendOwner(commandAliases, commandAlias.name, plugin.id);
    }
    for (const [contract, values] of Object.entries(plugin.contracts ?? {})) {
      if (Array.isArray(values) && values.length > 0) {
        appendOwner(contracts, contract, plugin.id);
      }
    }
  }

  return {
    channels: freezeOwnerMap(channels),
    channelConfigs: freezeOwnerMap(channelConfigs),
    providers: freezeOwnerMap(providers),
    modelCatalogProviders: freezeOwnerMap(modelCatalogProviders),
    cliBackends: freezeOwnerMap(cliBackends),
    setupProviders: freezeOwnerMap(setupProviders),
    commandAliases: freezeOwnerMap(commandAliases),
    contracts: freezeOwnerMap(contracts),
  };
}

export function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable {
  const totalStartedAt = performance.now();
  const registryStartedAt = performance.now();
  const registryResult = loadPluginRegistrySnapshotWithMetadata({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(params.index ? { index: params.index } : {}),
  });
  const registrySnapshotMs = performance.now() - registryStartedAt;
  const index = registryResult.snapshot;
  const manifestStartedAt = performance.now();
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  const manifestRegistryMs = performance.now() - manifestStartedAt;
  const startupPlanStartedAt = performance.now();
  const channelPluginIds = resolveChannelPluginIdsFromRegistry({ manifestRegistry });
  const configuredDeferredChannelPluginIds = resolveConfiguredDeferredChannelPluginIdsFromRegistry({
    config: params.config,
    env: params.env,
    index,
    manifestRegistry,
  });
  const pluginIds = resolveGatewayStartupPluginIdsFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index,
    manifestRegistry,
  });
  const startupPlanMs = performance.now() - startupPlanStartedAt;
  const normalizePluginId = createPluginRegistryIdNormalizer(index, { manifestRegistry });
  const byPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  const ownerMapsStartedAt = performance.now();
  const owners = buildOwnerMaps(manifestRegistry.plugins);
  const ownerMapsMs = performance.now() - ownerMapsStartedAt;
  const startup = {
    channelPluginIds,
    configuredDeferredChannelPluginIds,
    pluginIds,
  };
  const totalMs = performance.now() - totalStartedAt;

  return {
    key: hashJson({
      policyHash: index.policyHash,
      generatedAtMs: index.generatedAtMs,
      plugins: index.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.manifestHash,
        plugin.installRecordHash,
      ]),
      startup,
    }),
    index,
    registryDiagnostics: registryResult.diagnostics,
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    diagnostics: manifestRegistry.diagnostics,
    byPluginId,
    normalizePluginId,
    owners,
    startup,
    metrics: {
      registrySnapshotMs,
      manifestRegistryMs,
      startupPlanMs,
      ownerMapsMs,
      totalMs,
      indexPluginCount: index.plugins.length,
      manifestPluginCount: manifestRegistry.plugins.length,
      startupPluginCount: pluginIds.length,
      deferredChannelPluginCount: configuredDeferredChannelPluginIds.length,
    },
  };
}
