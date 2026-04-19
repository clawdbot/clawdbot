import { resolveBundledPluginCompatibleLoadValues } from "./activation-context.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  loadPluginManifestRegistry,
  resolveManifestContractPluginIds,
  type PluginManifestRecord,
} from "./manifest-registry.js";
import {
  createPluginIdScopeSet,
  normalizePluginIdScope,
  serializePluginIdScope,
} from "./plugin-scope.js";

export type WebProviderContract = "webSearchProviders" | "webFetchProviders";
export type WebProviderConfigKey = "webSearch" | "webFetch";

type WebProviderSortEntry = {
  id: string;
  pluginId: string;
  autoDetectOrder?: number;
};

function comparePluginProvidersAlphabetically(
  left: Pick<WebProviderSortEntry, "id" | "pluginId">,
  right: Pick<WebProviderSortEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortPluginProviders<T extends Pick<WebProviderSortEntry, "id" | "pluginId">>(
  providers: T[],
): T[] {
  return providers.toSorted(comparePluginProvidersAlphabetically);
}

export function sortPluginProvidersForAutoDetect<T extends WebProviderSortEntry>(
  providers: T[],
): T[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return comparePluginProvidersAlphabetically(left, right);
  });
}

function pluginManifestDeclaresProviderConfig(
  record: PluginManifestRecord,
  configKey: WebProviderConfigKey,
  contract: WebProviderContract,
): boolean {
  if ((record.contracts?.[contract]?.length ?? 0) > 0) {
    return true;
  }
  const configUiHintKeys = Object.keys(record.configUiHints ?? {});
  if (configUiHintKeys.some((key) => key === configKey || key.startsWith(`${configKey}.`))) {
    return true;
  }
  const properties = record.configSchema?.properties;
  return typeof properties === "object" && properties !== null && configKey in properties;
}

export function resolveManifestDeclaredWebProviderCandidatePluginIds(params: {
  contract: WebProviderContract;
  configKey: WebProviderConfigKey;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  const scopedPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  const onlyPluginIdSet = createPluginIdScopeSet(scopedPluginIds);
  const ids = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        pluginManifestDeclaresProviderConfig(plugin, params.configKey, params.contract),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  if (ids.length > 0) {
    return ids;
  }
  return scopedPluginIds?.length === 0 ? [] : undefined;
}

function resolveBundledWebProviderCompatPluginIds(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveManifestContractPluginIds({
    contract: params.contract,
    origin: "bundled",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

export function resolveBundledWebProviderResolutionConfig(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  const activation = resolveBundledPluginCompatibleLoadValues({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledAllowlistCompat,
      enablement: "always",
      vitest: true,
    },
    resolveCompatPluginIds: (compatParams) =>
      resolveBundledWebProviderCompatPluginIds({
        contract: params.contract,
        ...compatParams,
      }),
  });

  return {
    config: activation.config,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
  };
}

export function buildWebProviderSnapshotCacheKey(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  envKey: string | Record<string, string>;
}): string {
  const envKey =
    typeof params.envKey === "string"
      ? params.envKey
      : Object.entries(params.envKey).toSorted(([left], [right]) => left.localeCompare(right));
  const onlyPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  return JSON.stringify({
    workspaceDir: params.workspaceDir ?? "",
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    origin: params.origin ?? "",
    onlyPluginIds: serializePluginIdScope(onlyPluginIds),
    env: envKey,
  });
}

export function mapRegistryProviders<TProvider extends { id: string }>(params: {
  entries: readonly { pluginId: string; provider: TProvider }[];
  onlyPluginIds?: readonly string[];
  sortProviders: (
    providers: Array<TProvider & { pluginId: string }>,
  ) => Array<TProvider & { pluginId: string }>;
}): Array<TProvider & { pluginId: string }> {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  return params.sortProviders(
    params.entries
      .filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId))
      .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId })),
  );
}
