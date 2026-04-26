import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig,
} from "./config-normalization-shared.js";
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
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type {
  PluginManifestContractListKey,
  PluginManifestRecord,
  PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode =
  | "persisted-registry-disabled"
  | "persisted-registry-missing"
  | "persisted-registry-stale-policy";

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

export type PluginRegistryContributionOptions = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
};

export type LoadPluginRegistryManifestParams = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
  pluginIds?: readonly string[];
};

export type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
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

export type ResolvePluginContributionOwnersParams = PluginRegistryContributionOptions & {
  contribution: PluginRegistryContributionKey;
  matches: string | ((contributionId: string) => boolean);
};

export type ListPluginContributionIdsParams = PluginRegistryContributionOptions & {
  contribution: PluginRegistryContributionKey;
};

export type ResolveProviderOwnersParams = PluginRegistryContributionOptions & {
  providerId: string;
};

export type ResolveChannelOwnersParams = PluginRegistryContributionOptions & {
  channelId: string;
};

export type ResolveCliBackendOwnersParams = PluginRegistryContributionOptions & {
  cliBackendId: string;
};

export type ResolveSetupProviderOwnersParams = PluginRegistryContributionOptions & {
  setupProviderId: string;
};

export type ResolveManifestContractPluginIdsParams = LoadPluginRegistryParams & {
  contract: PluginManifestContractListKey;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
};

export type ResolveManifestContractOwnerPluginIdParams = LoadPluginRegistryParams & {
  contract: PluginManifestContractListKey;
  value: string | undefined;
  origin?: PluginOrigin;
};

export type ResolveManifestContractPluginIdsByCompatibilityRuntimePathParams =
  LoadPluginRegistryParams & {
    contract: PluginManifestContractListKey;
    path: string | undefined;
    origin?: PluginOrigin;
  };

function normalizeContributionId(value: string): string {
  return value.trim();
}

function normalizePluginRegistryAlias(value: string): string {
  return value.trim();
}

function normalizePluginRegistryAliasKey(value: string): string {
  return normalizePluginRegistryAlias(value).toLowerCase();
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
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

function loadManifestContractRegistry(
  params: LoadPluginRegistryParams & {
    onlyPluginIds?: readonly string[];
  },
): PluginManifestRegistry {
  return loadPluginManifestRegistryForPluginRegistry({
    ...params,
    pluginIds: params.onlyPluginIds,
    includeDisabled: true,
  });
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
      return collectObjectKeys(plugin.modelCatalog?.providers);
    case "commandAliases":
      return plugin.commandAliases?.map((alias) => alias.name) ?? [];
    case "contracts":
      return collectContractKeys(plugin);
  }
  return [];
}

function resolveContributionPluginIds(params: {
  index: PluginRegistrySnapshot;
  includeDisabled?: boolean;
  config?: OpenClawConfig;
}): readonly string[] {
  if (params.includeDisabled) {
    return params.index.plugins.map((plugin) => plugin.pluginId);
  }
  return params.index.plugins
    .filter((plugin) => isInstalledPluginEnabled(params.index, plugin.pluginId, params.config))
    .map((plugin) => plugin.pluginId);
}

function loadContributionManifestRegistry(
  params: LoadPluginRegistryParams & {
    index: PluginRegistrySnapshot;
    includeDisabled?: boolean;
  },
): PluginManifestRegistry {
  return loadPluginManifestRegistryForInstalledIndex({
    index: params.index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds: resolveContributionPluginIds({
      index: params.index,
      includeDisabled: params.includeDisabled,
      config: params.config,
    }),
    includeDisabled: true,
  });
}

export function loadPluginManifestRegistryForPluginRegistry(
  params: LoadPluginRegistryManifestParams = {},
): PluginManifestRegistry {
  const index = resolveSnapshot(params);
  return loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds: params.pluginIds,
    includeDisabled: params.includeDisabled,
  });
}

export function createPluginRegistryIdNormalizer(
  index: PluginRegistrySnapshot,
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of index.plugins) {
    const pluginId = normalizePluginRegistryAlias(plugin.pluginId);
    if (pluginId) {
      aliases.set(normalizePluginRegistryAliasKey(pluginId), plugin.pluginId);
    }
  }
  const registry = loadPluginManifestRegistryForInstalledIndex({
    index,
    includeDisabled: true,
  });
  for (const plugin of [...registry.plugins].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const pluginId = normalizePluginRegistryAlias(plugin.id);
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginRegistryAliasKey(pluginId), plugin.id);
    for (const alias of [
      plugin.id,
      ...listManifestContributionIds(plugin, "providers"),
      ...listManifestContributionIds(plugin, "channels"),
      ...listManifestContributionIds(plugin, "setupProviders"),
      ...listManifestContributionIds(plugin, "cliBackends"),
      ...listManifestContributionIds(plugin, "modelCatalogProviders"),
      ...(plugin.legacyPluginIds ?? []),
    ]) {
      const normalizedAlias = normalizePluginRegistryAlias(alias);
      const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
      if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
        aliases.set(normalizedAliasKey, pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const trimmed = normalizePluginRegistryAlias(pluginId);
    return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
  };
}

export function normalizePluginsConfigWithRegistry(
  config: OpenClawConfig["plugins"] | undefined,
  index: PluginRegistrySnapshot,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolver(config, createPluginRegistryIdNormalizer(index));
}

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
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
  if (persistedReadsEnabled) {
    const persisted = readPersistedInstalledPluginIndexSync(params);
    if (persisted) {
      if (
        params.config &&
        persisted.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-policy",
          message:
            "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else {
        return {
          snapshot: persisted,
          source: "persisted",
          diagnostics,
        };
      }
    } else {
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
        extractPluginInstallRecordsFromInstalledPluginIndex(
          persistedReadsEnabled ? readPersistedInstalledPluginIndexSync(params) : null,
        ),
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

export function listPluginContributionIds(
  params: ListPluginContributionIdsParams,
): readonly string[] {
  const index = resolveSnapshot(params);
  const registry = loadContributionManifestRegistry({
    ...params,
    index,
  });
  return sortUnique(
    registry.plugins.flatMap((plugin) => listManifestContributionIds(plugin, params.contribution)),
  );
}

export function resolvePluginContributionOwners(
  params: ResolvePluginContributionOwnersParams,
): readonly string[] {
  const matcher =
    typeof params.matches === "string"
      ? (contributionId: string) => contributionId === params.matches
      : params.matches;
  const index = resolveSnapshot(params);
  const registry = loadContributionManifestRegistry({
    ...params,
    index,
  });
  return sortUnique(
    registry.plugins.flatMap((plugin) =>
      listManifestContributionIds(plugin, params.contribution).some(matcher) ? [plugin.id] : [],
    ),
  );
}

export function resolveProviderOwners(params: ResolveProviderOwnersParams): readonly string[] {
  const providerId = normalizeProviderId(params.providerId);
  if (!providerId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "providers",
    matches: (contributionId) => normalizeProviderId(contributionId) === providerId,
  });
}

export function resolveChannelOwners(params: ResolveChannelOwnersParams): readonly string[] {
  const channelId = normalizeContributionId(params.channelId);
  if (!channelId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "channels",
    matches: channelId,
  });
}

export function resolveCliBackendOwners(params: ResolveCliBackendOwnersParams): readonly string[] {
  const cliBackendId = normalizeContributionId(params.cliBackendId);
  if (!cliBackendId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "cliBackends",
    matches: cliBackendId,
  });
}

export function resolveSetupProviderOwners(
  params: ResolveSetupProviderOwnersParams,
): readonly string[] {
  const setupProviderId = normalizeContributionId(params.setupProviderId);
  if (!setupProviderId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "setupProviders",
    matches: setupProviderId,
  });
}

export function resolveManifestContractPluginIds(
  params: ResolveManifestContractPluginIdsParams,
): string[] {
  return loadManifestContractRegistry(params)
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        listManifestContractValues(plugin, params.contract).length > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestContractPluginIdsByCompatibilityRuntimePath(
  params: ResolveManifestContractPluginIdsByCompatibilityRuntimePathParams,
): string[] {
  const normalizedPath = params.path?.trim();
  if (!normalizedPath) {
    return [];
  }
  return loadManifestContractRegistry(params)
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        listManifestContractValues(plugin, params.contract).length > 0 &&
        (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(normalizedPath),
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
  return loadManifestContractRegistry(params).plugins.find(
    (plugin) =>
      (!params.origin || plugin.origin === params.origin) &&
      listManifestContractValues(plugin, params.contract).some(
        (candidate) => normalizeContributionId(candidate).toLowerCase() === normalizedValue,
      ),
  )?.id;
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
