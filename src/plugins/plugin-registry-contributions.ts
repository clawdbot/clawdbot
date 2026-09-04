/** Loads manifest and installed-index contributions used to build plugin registry snapshots. */
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizePluginsConfigWithResolverCore,
  type NormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import { createInstalledPluginEnabledPredicate } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type {
  BundledChannelConfigCollector,
  PluginManifestContractListKey,
  PluginManifestRecord,
  PluginManifestRegistry,
} from "./manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  createPluginRegistryIdNormalizer,
  type PluginRegistryIdNormalizerOptions,
} from "./plugin-registry-id-normalizer.js";
import {
  loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata,
  type LoadPluginRegistryParams,
  type PluginRegistrySnapshot,
} from "./plugin-registry-snapshot.js";
export { createPluginRegistryIdNormalizer } from "./plugin-registry-id-normalizer.js";

type PluginLookUpTable = Pick<
  PluginMetadataSnapshot,
  "index" | "manifestRegistry" | "plugins" | "normalizePluginId" | "owners"
>;

type PluginRegistryContributionOptions = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
  lookUpTable?: PluginLookUpTable;
};

type LoadPluginRegistryManifestParams = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
  pluginIds?: readonly string[];
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
};

export type PluginRegistryContributionKey =
  | "providers"
  | "channels"
  | "channelConfigs"
  | "setupProviders"
  | "cliBackends"
  | "modelCatalogProviders"
  | "commandAliases"
  | "contracts";

type ResolvePluginContributionOwnersParams = PluginRegistryContributionOptions & {
  contribution: PluginRegistryContributionKey;
  matches: string | ((contributionId: string) => boolean);
};

type ListPluginContributionIdsParams = PluginRegistryContributionOptions & {
  contribution: PluginRegistryContributionKey;
};

type ManifestContractLookupParams = LoadPluginRegistryParams & {
  manifestRecords?: readonly PluginManifestRecord[];
};

type ResolveManifestContractPluginIdsParams = ManifestContractLookupParams & {
  contract: PluginManifestContractListKey;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
};

type ResolveManifestContractOwnerPluginIdParams = ManifestContractLookupParams & {
  contract: PluginManifestContractListKey;
  value: string | undefined;
  origin?: PluginOrigin;
};

function normalizeContributionId(value: string): string {
  return value.trim();
}

function collectObjectKeys(value: Record<string, unknown> | undefined): readonly string[] {
  return value ? Object.keys(value) : [];
}

function collectContractKeys(plugin: PluginManifestRecord): readonly string[] {
  const contracts = plugin.contracts;
  if (!contracts) {
    return [];
  }
  return Object.entries(contracts).flatMap(([key, value]) =>
    Array.isArray(value) && value.length > 0 ? [key] : [],
  );
}

function listManifestContractValues(
  plugin: PluginManifestRecord,
  contract: PluginManifestContractListKey,
): readonly string[] {
  return plugin.contracts?.[contract] ?? [];
}

function loadManifestContractRecords(
  params: ManifestContractLookupParams & {
    onlyPluginIds?: readonly string[];
  },
): readonly PluginManifestRecord[] {
  let records = params.manifestRecords;
  if (!records) {
    const requiresExplicitRegistry =
      params.index !== undefined ||
      params.preferPersisted === false ||
      params.allowCurrent === false ||
      params.stateDir !== undefined ||
      params.filePath !== undefined ||
      params.pluginIndexFilePath !== undefined ||
      params.installRecords !== undefined ||
      params.candidates !== undefined ||
      params.diagnostics !== undefined ||
      params.discovery !== undefined ||
      params.now !== undefined;
    if (requiresExplicitRegistry) {
      return loadPluginManifestRegistryForPluginRegistry({
        ...params,
        pluginIds: params.onlyPluginIds,
        includeDisabled: true,
      }).plugins;
    }
    records = resolvePluginMetadataSnapshot({
      config: params.config,
      env: params.env,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
    }).plugins;
  }
  if (params.onlyPluginIds === undefined) {
    return records;
  }
  const pluginIds = new Set(params.onlyPluginIds);
  return records.filter((record) => pluginIds.has(record.id));
}

function listManifestContributionIds(
  plugin: PluginManifestRecord,
  contribution: PluginRegistryContributionKey,
): readonly string[] {
  switch (contribution) {
    case "providers":
      return plugin.providers;
    case "channels":
      return plugin.channels;
    case "channelConfigs":
      return collectObjectKeys(plugin.channelConfigs);
    case "setupProviders":
      return plugin.setup?.providers?.map((provider) => provider.id) ?? [];
    case "cliBackends":
      return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])];
    case "modelCatalogProviders":
      return [
        ...collectObjectKeys(plugin.modelCatalog?.providers),
        ...collectObjectKeys(plugin.modelCatalog?.aliases),
      ];
    case "commandAliases":
      return plugin.commandAliases?.map((alias) => alias.name) ?? [];
    case "contracts":
      return collectContractKeys(plugin);
  }
  return [];
}

function createContributionPluginFilter(
  params: PluginRegistryContributionOptions,
  index: PluginRegistrySnapshot,
): (pluginId: string) => boolean {
  if (params.includeDisabled) {
    // Keep disabled-owner inspection within the supplied installed inventory.
    const installedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
    return (pluginId) => installedPluginIds.has(pluginId);
  }
  return createInstalledPluginEnabledPredicate(index.plugins, params.config, params.env);
}

function loadContributionManifestRegistry(
  params: LoadPluginRegistryParams & {
    index: PluginRegistrySnapshot;
    includeDisabled?: boolean;
  },
): PluginManifestRegistry {
  const pluginIds = params.index.plugins.map((plugin) => plugin.pluginId);
  return loadPluginManifestRegistryForInstalledIndex({
    index: params.index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds: params.includeDisabled
      ? pluginIds
      : pluginIds.filter(
          createInstalledPluginEnabledPredicate(params.index.plugins, params.config, params.env),
        ),
    includeDisabled: true,
  });
}

function listContributionManifestPlugins(
  params: PluginRegistryContributionOptions & {
    index: PluginRegistrySnapshot;
  },
): readonly PluginManifestRecord[] {
  const plugins = params.lookUpTable?.plugins;
  if (plugins) {
    const includePlugin = createContributionPluginFilter(params, params.index);
    return plugins.filter((plugin) => includePlugin(plugin.id));
  }
  return loadContributionManifestRegistry({
    ...params,
    index: params.index,
  }).plugins;
}

export function loadPluginManifestRegistryForPluginRegistry(
  params: LoadPluginRegistryManifestParams = {},
): PluginManifestRegistry {
  const { snapshot: index, manifestRegistry } = loadPluginRegistrySnapshotWithMetadata(params);
  return loadPluginManifestRegistryForInstalledIndex({
    index,
    ...(manifestRegistry ? { manifestRegistry } : {}),
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds: params.pluginIds,
    includeDisabled: params.includeDisabled,
    ...(params.bundledChannelConfigCollector
      ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
      : {}),
  });
}

export function normalizePluginsConfigWithRegistry(
  config: OpenClawConfig["plugins"] | undefined,
  index: PluginRegistrySnapshot,
  options: PluginRegistryIdNormalizerOptions = {},
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolverCore(
    config,
    createPluginRegistryIdNormalizer(index, options),
  );
}

export function listPluginContributionIds(
  params: ListPluginContributionIdsParams,
): readonly string[] {
  const index = params.lookUpTable?.index ?? loadPluginRegistrySnapshot(params);
  const plugins = listContributionManifestPlugins({ ...params, index });
  return normalizeSortedUniqueStringEntries(
    plugins.flatMap((plugin) => listManifestContributionIds(plugin, params.contribution)),
  );
}

export function resolvePluginContributionOwners(
  params: ResolvePluginContributionOwnersParams,
): readonly string[] {
  const index = params.lookUpTable?.index ?? loadPluginRegistrySnapshot(params);
  if (params.lookUpTable && typeof params.matches === "string") {
    const owners = params.lookUpTable.owners[params.contribution].get(params.matches);
    if (!owners) {
      return [];
    }
    return normalizeSortedUniqueStringEntries(
      owners.filter(createContributionPluginFilter(params, index)),
    );
  }
  const matcher =
    typeof params.matches === "string"
      ? (contributionId: string) => contributionId === params.matches
      : params.matches;
  const plugins = listContributionManifestPlugins({ ...params, index });
  return normalizeSortedUniqueStringEntries(
    plugins.flatMap((plugin) =>
      listManifestContributionIds(plugin, params.contribution).some(matcher) ? [plugin.id] : [],
    ),
  );
}

export function resolveManifestContractPluginIds(
  params: ResolveManifestContractPluginIdsParams,
): string[] {
  return loadManifestContractRecords(params)
    .filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        listManifestContractValues(plugin, params.contract).length > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestContractOwnerPluginId(
  params: ResolveManifestContractOwnerPluginIdParams,
): string | undefined {
  const normalizedValue = normalizeContributionId(params.value ?? "").toLowerCase();
  if (!normalizedValue) {
    return undefined;
  }
  return loadManifestContractRecords(params).find(
    (plugin) =>
      (!params.origin || plugin.origin === params.origin) &&
      listManifestContractValues(plugin, params.contract).some(
        (candidate) => normalizeContributionId(candidate).toLowerCase() === normalizedValue,
      ),
  )?.id;
}
