import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { sortUniqueStrings } from "../shared/string-normalization.js";
import { withBundledPluginVitestCompat } from "./bundled-compat.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  isActivatedManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import {
  loadPluginRegistrySnapshot,
  normalizePluginsConfigWithRegistry,
  type PluginRegistryRecord,
  type PluginRegistrySnapshot,
} from "./plugin-registry.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";

type ProviderManifestLoadParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  registry?: PluginRegistrySnapshot;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry"> &
    Partial<Pick<PluginMetadataSnapshot, "owners" | "byPluginId">>;
};
type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfigWithRegistry>;
type ProviderRegistryLoadParams = ProviderManifestLoadParams & {
  onlyPluginIds?: readonly string[];
};

function loadProviderRegistrySnapshot(params: ProviderManifestLoadParams): PluginRegistrySnapshot {
  if (params.registry) {
    return params.registry;
  }
  return loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
}

function loadScopedProviderRegistry(params: ProviderRegistryLoadParams): {
  registry: PluginRegistrySnapshot;
  onlyPluginIdSet: ReturnType<typeof createPluginIdScopeSet>;
} {
  return {
    registry: loadProviderRegistrySnapshot(params),
    onlyPluginIdSet: createPluginIdScopeSet(params.onlyPluginIds),
  };
}

function listRegistryPluginIds(
  registry: PluginRegistrySnapshot,
  predicate: (plugin: PluginRegistryRecord) => boolean,
): string[] {
  return registry.plugins
    .filter(predicate)
    .map((plugin) => plugin.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveProviderSurfacePluginIdSet(
  params: ProviderManifestLoadParams & {
    registry: PluginRegistrySnapshot;
  },
): ReadonlySet<string> {
  return new Set(
    resolveManifestRegistry({
      ...params,
      includeDisabled: true,
    }).plugins.flatMap((plugin) => (plugin.providers.length > 0 ? [plugin.id] : [])),
  );
}

function pluginOwnsProviderRef(plugin: PluginManifestRecord, normalizedProvider: string): boolean {
  if (
    plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider)
  ) {
    return true;
  }
  for (const [rawAlias, target] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
    const alias = normalizeProviderId(rawAlias);
    const targetProvider = normalizeProviderId(target.provider);
    if (
      alias === normalizedProvider &&
      targetProvider &&
      plugin.providers.some((providerId) => normalizeProviderId(providerId) === targetProvider)
    ) {
      return true;
    }
  }
  return false;
}

function resolvesRuntimeModelCatalogAugment(plugin: PluginManifestRecord): boolean {
  return (
    plugin.modelCatalog?.runtimeAugment === true ||
    (plugin.origin !== "bundled" && plugin.providers.length > 0)
  );
}

function resolveProviderOwnerPluginIds(
  params: ProviderRegistryLoadParams & {
    pluginIds: readonly string[];
    isEligible: (
      plugin: PluginRegistryRecord,
      normalizedConfig: NormalizedPluginsConfig,
    ) => boolean;
  },
): string[] {
  if (params.pluginIds.length === 0) {
    return [];
  }
  const pluginIdSet = new Set(params.pluginIds);
  const registry = loadProviderRegistrySnapshot(params);
  const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, {
    manifestRegistry: params.manifestRegistry,
  });
  return listRegistryPluginIds(
    registry,
    (plugin) => pluginIdSet.has(plugin.pluginId) && params.isEligible(plugin, normalizedConfig),
  );
}

function resolveEffectiveRegistryPluginActivation(params: {
  plugin: PluginRegistryRecord;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: PluginLoadOptions["config"];
}) {
  return resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.normalizedConfig,
    rootConfig: params.rootConfig,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin),
  });
}

function toManifestOwnerRecord(plugin: PluginRegistryRecord) {
  return {
    id: plugin.pluginId,
    origin: plugin.origin,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
  };
}

export function withBundledProviderVitestCompat(params: {
  config: PluginLoadOptions["config"];
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"] {
  return withBundledPluginVitestCompat(params);
}

export function resolveBundledProviderCompatPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  if (params.manifestRegistry) {
    const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
    return params.manifestRegistry.plugins
      .filter(
        (plugin) =>
          plugin.origin === "bundled" &&
          plugin.providers.length > 0 &&
          (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
  }
  const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
  const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({ ...params, registry });
  return listRegistryPluginIds(
    registry,
    (plugin) =>
      plugin.origin === "bundled" &&
      providerSurfacePluginIds.has(plugin.pluginId) &&
      (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)),
  );
}

export function resolveEnabledProviderPluginIds(params: ProviderRegistryLoadParams): string[] {
  const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
  const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({ ...params, registry });
  const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, {
    manifestRegistry: params.manifestRegistry,
  });
  return listRegistryPluginIds(
    registry,
    (plugin) =>
      providerSurfacePluginIds.has(plugin.pluginId) &&
      (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)) &&
      resolveEffectiveRegistryPluginActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }).activated,
  );
}

export function resolveExternalAuthProfileProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  return resolveRegistryManifestContractPluginIds({
    ...params,
    contract: "externalAuthProviders",
  });
}

function resolveRegistryManifestContractPluginIds(params: {
  contract: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  origin?: PluginRegistryRecord["origin"];
  onlyPluginIds?: readonly string[];
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
  return resolveManifestRegistry({
    ...params,
    registry,
    includeDisabled: true,
  })
    .plugins.filter((plugin) => {
      if (params.origin && plugin.origin !== params.origin) {
        return false;
      }
      if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) {
        return false;
      }
      return (
        (plugin.contracts?.[params.contract as keyof NonNullable<typeof plugin.contracts>] ?? [])
          .length > 0
      );
    })
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveExternalAuthProfileCompatFallbackPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  declaredPluginIds?: ReadonlySet<string>;
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  const declaredPluginIds =
    params.declaredPluginIds ?? new Set(resolveExternalAuthProfileProviderPluginIds(params));
  const registry = loadProviderRegistrySnapshot(params);
  const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({ ...params, registry });
  const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, {
    manifestRegistry: params.manifestRegistry,
  });
  return listRegistryPluginIds(
    registry,
    (plugin) =>
      plugin.origin !== "bundled" &&
      providerSurfacePluginIds.has(plugin.pluginId) &&
      !declaredPluginIds.has(plugin.pluginId) &&
      isProviderPluginEligibleForRuntimeOwnerActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }),
  );
}

export function resolveDiscoveredProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  registry?: PluginRegistrySnapshot;
  manifestRegistry?: PluginManifestRegistry;
  onlyPluginIds?: readonly string[];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
  const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({ ...params, registry });
  const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins !== true;
  const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, {
    manifestRegistry: params.manifestRegistry,
  });
  return listRegistryPluginIds(registry, (plugin) => {
    if (
      !(
        providerSurfacePluginIds.has(plugin.pluginId) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId))
      )
    ) {
      return false;
    }
    return isProviderPluginEligibleForSetupDiscovery({
      plugin,
      shouldFilterUntrustedWorkspacePlugins,
      normalizedConfig,
      rootConfig: params.config,
    });
  });
}

function isProviderPluginEligibleForSetupDiscovery(params: {
  plugin: PluginRegistryRecord;
  shouldFilterUntrustedWorkspacePlugins: boolean;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: PluginLoadOptions["config"];
}): boolean {
  if (params.plugin.origin === "workspace") {
    if (!params.shouldFilterUntrustedWorkspacePlugins) {
      return true;
    }
  }
  if (
    !passesManifestOwnerBasePolicy({
      plugin: toManifestOwnerRecord(params.plugin),
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  return isActivatedManifestOwner({
    plugin: toManifestOwnerRecord(params.plugin),
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveDiscoverableProviderOwnerPluginIds(params: {
  pluginIds: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  registry?: PluginRegistrySnapshot;
  manifestRegistry?: PluginManifestRegistry;
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins !== true;
  return resolveProviderOwnerPluginIds({
    ...params,
    isEligible: (plugin, normalizedConfig) =>
      isProviderPluginEligibleForSetupDiscovery({
        plugin,
        shouldFilterUntrustedWorkspacePlugins,
        normalizedConfig,
        rootConfig: params.config,
      }),
  });
}

function isProviderPluginEligibleForRuntimeOwnerActivation(params: {
  plugin: PluginRegistryRecord;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: PluginLoadOptions["config"];
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: toManifestOwnerRecord(params.plugin),
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (params.plugin.origin !== "workspace") {
    return true;
  }
  return isActivatedManifestOwner({
    plugin: toManifestOwnerRecord(params.plugin),
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveActivatableProviderOwnerPluginIds(params: {
  pluginIds: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  registry?: PluginRegistrySnapshot;
  manifestRegistry?: PluginManifestRegistry;
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  return resolveProviderOwnerPluginIds({
    ...params,
    isEligible: (plugin, normalizedConfig) =>
      isProviderPluginEligibleForRuntimeOwnerActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }),
  });
}

export const testing = {
  resolveActivatableProviderOwnerPluginIds,
  resolveEnabledProviderPluginIds,
  resolveExternalAuthProfileCompatFallbackPluginIds,
  resolveExternalAuthProfileProviderPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  withBundledProviderVitestCompat,
} as const;

type ModelSupportMatchKind = "pattern" | "prefix";

function resolveManifestRegistry(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
  manifestRegistry?: PluginManifestRegistry;
  registry?: PluginRegistrySnapshot;
  includeDisabled?: boolean;
}): PluginManifestRegistry {
  if (params.manifestRegistry) {
    return params.manifestRegistry;
  }
  if (params.metadataSnapshot) {
    return params.metadataSnapshot.manifestRegistry;
  }
  if (!params.registry) {
    const currentSnapshot = getCurrentPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      allowWorkspaceScopedSnapshot: true,
    });
    if (currentSnapshot) {
      return currentSnapshot.manifestRegistry;
    }
  }
  const registry = params.registry ?? loadProviderRegistrySnapshot(params);
  return loadPluginManifestRegistryForInstalledIndex({
    index: registry,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: params.includeDisabled,
  });
}

function stripModelProfileSuffix(value: string): string {
  return splitTrailingAuthProfile(value).model;
}

function splitExplicitModelRef(rawModel: string): { provider?: string; modelId: string } | null {
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const modelId = stripModelProfileSuffix(trimmed);
    return modelId ? { modelId } : null;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  const modelId = stripModelProfileSuffix(trimmed.slice(slash + 1));
  if (!provider || !modelId) {
    return null;
  }
  return { provider, modelId };
}

function resolveModelSupportMatchKind(
  plugin: PluginManifestRecord,
  modelId: string,
): ModelSupportMatchKind | undefined {
  const patterns = plugin.modelSupport?.modelPatterns ?? [];
  for (const patternSource of patterns) {
    // compileSafeRegex rejects patterns with nested repetition (ReDoS risk)
    // and returns null. Rejected patterns are silently skipped: the plugin
    // will not match via that pattern but other patterns/prefixes still apply.
    const regex = compileSafeRegex(patternSource, "u");
    if (regex?.test(modelId)) {
      return "pattern";
    }
  }
  const prefixes = plugin.modelSupport?.modelPrefixes ?? [];
  for (const prefix of prefixes) {
    if (modelId.startsWith(prefix)) {
      return "prefix";
    }
  }
  return undefined;
}

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return sortUniqueStrings(values);
}

function listNormalizedOwnerMapPluginIds(
  owners: ReadonlyMap<string, readonly string[]>,
  normalizedId: string,
): string[] {
  const matched: string[] = [];
  for (const [ownedId, pluginIds] of owners) {
    if (normalizeProviderId(ownedId) === normalizedId) {
      matched.push(...pluginIds);
    }
  }
  return dedupeSortedPluginIds(matched);
}

function resolveOwningPluginIdsForProviderFromSnapshot(
  snapshot: Pick<PluginMetadataSnapshot, "owners" | "byPluginId">,
  normalizedProvider: string,
): string[] | undefined {
  const directOwners = listNormalizedOwnerMapPluginIds(
    snapshot.owners.providers,
    normalizedProvider,
  );
  const aliasOwners = listNormalizedOwnerMapPluginIds(
    snapshot.owners.modelCatalogProviders,
    normalizedProvider,
  ).filter((pluginId) => {
    const plugin = snapshot.byPluginId.get(pluginId);
    return plugin ? pluginOwnsProviderRef(plugin, normalizedProvider) : false;
  });
  const pluginIds = dedupeSortedPluginIds([...directOwners, ...aliasOwners]);
  return pluginIds.length > 0 ? pluginIds : undefined;
}

function resolvePreferredManifestPluginIds(
  registry: PluginManifestRegistry,
  matchedPluginIds: readonly string[],
): string[] | undefined {
  if (matchedPluginIds.length === 0) {
    return undefined;
  }
  const uniquePluginIds = dedupeSortedPluginIds(matchedPluginIds);
  if (uniquePluginIds.length <= 1) {
    return uniquePluginIds;
  }
  const nonBundledPluginIds = uniquePluginIds.filter((pluginId) => {
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);
    return plugin?.origin !== "bundled";
  });
  if (nonBundledPluginIds.length === 1) {
    return nonBundledPluginIds;
  }
  if (nonBundledPluginIds.length > 1) {
    return undefined;
  }
  return undefined;
}

export function resolveOwningPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "owners" | "manifestRegistry" | "byPluginId">;
}): string[] | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }

  const metadataSnapshot =
    params.metadataSnapshot ??
    (params.manifestRegistry
      ? undefined
      : getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: params.env,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          allowWorkspaceScopedSnapshot: true,
        }));
  if (metadataSnapshot) {
    const ownerIds = resolveOwningPluginIdsForProviderFromSnapshot(
      metadataSnapshot,
      normalizedProvider,
    );
    if (ownerIds) {
      return ownerIds;
    }
  }

  const manifestRegistry =
    params.manifestRegistry ??
    metadataSnapshot?.manifestRegistry ??
    loadPluginMetadataSnapshot({
      config: params.config ?? {},
      workspaceDir: params.workspaceDir,
      env: params.env ?? process.env,
    }).manifestRegistry;

  const pluginIds = manifestRegistry.plugins
    .filter((plugin) => pluginOwnsProviderRef(plugin, normalizedProvider))
    .map((plugin) => plugin.id);

  return pluginIds.length > 0 ? pluginIds : undefined;
}

function resolveOwningPluginIdsForCliBackend(params: {
  backend: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "owners" | "manifestRegistry">;
}): string[] | undefined {
  const normalizedBackend = normalizeProviderId(params.backend);
  if (!normalizedBackend) {
    return undefined;
  }

  const metadataSnapshot =
    params.metadataSnapshot ??
    (params.manifestRegistry
      ? undefined
      : getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: params.env,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          allowWorkspaceScopedSnapshot: true,
        }));
  if (metadataSnapshot) {
    const ownerIds = listNormalizedOwnerMapPluginIds(
      metadataSnapshot.owners.cliBackends,
      normalizedBackend,
    );
    if (ownerIds.length > 0) {
      return ownerIds;
    }
  }

  const manifestRegistry =
    params.manifestRegistry ??
    metadataSnapshot?.manifestRegistry ??
    loadPluginMetadataSnapshot({
      config: params.config ?? {},
      workspaceDir: params.workspaceDir,
      env: params.env ?? process.env,
    }).manifestRegistry;

  const pluginIds = manifestRegistry.plugins
    .filter(
      (plugin) =>
        plugin.cliBackends.some(
          (backendId) => normalizeProviderId(backendId) === normalizedBackend,
        ) ||
        (plugin.setup?.cliBackends ?? []).some(
          (backendId) => normalizeProviderId(backendId) === normalizedBackend,
        ),
    )
    .map((plugin) => plugin.id);

  const deduped = dedupeSortedPluginIds(pluginIds);
  return deduped.length > 0 ? deduped : undefined;
}

export function resolveOwningPluginIdsForProviderRef(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "owners" | "manifestRegistry" | "byPluginId">;
}): string[] | undefined {
  return (
    resolveOwningPluginIdsForProvider(params) ??
    resolveOwningPluginIdsForCliBackend({
      backend: params.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRegistry: params.manifestRegistry,
      metadataSnapshot: params.metadataSnapshot,
    })
  );
}

export function resolveOwningPluginIdsForModelRef(params: {
  model: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
  registry?: PluginRegistrySnapshot;
}): string[] | undefined {
  const parsed = splitExplicitModelRef(params.model);
  if (!parsed) {
    return undefined;
  }

  if (parsed.provider) {
    const providerOwners = resolveOwningPluginIdsForProvider({
      provider: parsed.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRegistry: params.manifestRegistry,
    });
    return (
      providerOwners ??
      resolveOwningPluginIdsForCliBackend({
        backend: parsed.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        manifestRegistry: params.manifestRegistry,
      })
    );
  }

  const manifestRegistry = resolveManifestRegistry({
    ...params,
    includeDisabled: true,
  });
  const matchedByPattern = manifestRegistry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "pattern")
    .map((plugin) => plugin.id);
  const preferredPatternPluginIds = resolvePreferredManifestPluginIds(
    manifestRegistry,
    matchedByPattern,
  );
  if (preferredPatternPluginIds) {
    return preferredPatternPluginIds;
  }

  const matchedByPrefix = manifestRegistry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "prefix")
    .map((plugin) => plugin.id);
  return resolvePreferredManifestPluginIds(manifestRegistry, matchedByPrefix);
}

export function resolveOwningPluginIdsForModelRefs(params: {
  models: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  const registry = params.manifestRegistry ? undefined : loadProviderRegistrySnapshot(params);
  const manifestRegistry = params.manifestRegistry;
  return dedupeSortedPluginIds(
    params.models.flatMap(
      (model) =>
        resolveOwningPluginIdsForModelRef({
          model,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          ...(manifestRegistry ? { manifestRegistry } : {}),
          ...(registry ? { registry } : {}),
        }) ?? [],
    ),
  );
}

export function resolveNonBundledProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadProviderRegistrySnapshot(params);
  const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({ ...params, registry });
  const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
  return listRegistryPluginIds(
    registry,
    (plugin) =>
      plugin.origin !== "bundled" &&
      providerSurfacePluginIds.has(plugin.pluginId) &&
      resolveEffectiveRegistryPluginActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }).activated,
  );
}

export function resolveCatalogHookProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadProviderRegistrySnapshot(params);
  const manifestRegistry = resolveManifestRegistry({
    ...params,
    registry,
    includeDisabled: true,
  });
  const providerSurfacePluginIds = new Set(
    manifestRegistry.plugins.flatMap((plugin) => (plugin.providers.length > 0 ? [plugin.id] : [])),
  );
  const runtimeAugmentPluginIds = new Set(
    manifestRegistry.plugins.flatMap((plugin) =>
      resolvesRuntimeModelCatalogAugment(plugin) ? [plugin.id] : [],
    ),
  );
  const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
  const enabledProviderPluginIds = listRegistryPluginIds(
    registry,
    (plugin) =>
      providerSurfacePluginIds.has(plugin.pluginId) &&
      runtimeAugmentPluginIds.has(plugin.pluginId) &&
      resolveEffectiveRegistryPluginActivation({
        plugin,
        normalizedConfig,
        rootConfig: params.config,
      }).activated,
  );
  const bundledCompatPluginIds = resolveBundledProviderCompatPluginIds({
    ...params,
    manifestRegistry,
  }).filter((pluginId) => runtimeAugmentPluginIds.has(pluginId));
  return dedupeSortedPluginIds([...enabledProviderPluginIds, ...bundledCompatPluginIds]);
}
export { testing as __testing };
