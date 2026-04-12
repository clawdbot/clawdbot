import { normalizeProviderId } from "../agents/provider-id.js";
import { withBundledPluginVitestCompat } from "./bundled-compat.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  isActivatedManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";

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
}): string[] {
  const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return registry.plugins
    .filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        plugin.providers.length > 0 &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveEnabledProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
}): string[] {
  const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return registry.plugins
    .filter(
      (plugin) =>
        plugin.providers.length > 0 &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalizedConfig,
          rootConfig: params.config,
          enabledByDefault: plugin.enabledByDefault,
        }).activated,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveDiscoveredProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return registry.plugins
    .filter((plugin) => {
      if (!(plugin.providers.length > 0 && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)))) {
        return false;
      }
      return isProviderPluginEligibleForSetupDiscovery({
        plugin,
        shouldFilterUntrustedWorkspacePlugins,
        normalizedConfig,
        rootConfig: params.config,
      });
    })
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function isProviderPluginEligibleForSetupDiscovery(params: {
  plugin: PluginManifestRecord;
  shouldFilterUntrustedWorkspacePlugins: boolean;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig?: PluginLoadOptions["config"];
}): boolean {
  if (!params.shouldFilterUntrustedWorkspacePlugins || params.plugin.origin !== "workspace") {
    return true;
  }
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveDiscoverableProviderOwnerPluginIds(params: {
  pluginIds: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  if (params.pluginIds.length === 0) {
    return [];
  }
  const pluginIdSet = new Set(params.pluginIds);
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return registry.plugins
    .filter(
      (plugin) =>
        pluginIdSet.has(plugin.id) &&
        isProviderPluginEligibleForSetupDiscovery({
          plugin,
          shouldFilterUntrustedWorkspacePlugins,
          normalizedConfig,
          rootConfig: params.config,
        }),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function isProviderPluginEligibleForRuntimeOwnerActivation(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig?: PluginLoadOptions["config"];
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (params.plugin.origin !== "workspace") {
    return true;
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveActivatableProviderOwnerPluginIds(params: {
  pluginIds: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  includeUntrustedWorkspacePlugins?: boolean;
}): string[] {
  if (params.pluginIds.length === 0) {
    return [];
  }
  const pluginIdSet = new Set(params.pluginIds);
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return registry.plugins
    .filter(
      (plugin) =>
        pluginIdSet.has(plugin.id) &&
        isProviderPluginEligibleForRuntimeOwnerActivation({
          plugin,
          normalizedConfig,
          rootConfig: params.config,
        }),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export const __testing = {
  resolveActivatableProviderOwnerPluginIds,
  resolveEnabledProviderPluginIds,
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
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  return (
    params.manifestRegistry ??
    loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })
  );
}

function stripModelProfileSuffix(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  return at <= 0 ? trimmed : trimmed.slice(0, at).trim();
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
    try {
      if (new RegExp(patternSource, "u").test(modelId)) {
        return "pattern";
      }
    } catch {
      continue;
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
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
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
}): string[] | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }

  const registry = resolveManifestRegistry(params);
  const pluginIds = registry.plugins
    .filter(
      (plugin) =>
        plugin.providers.some(
          (providerId) => normalizeProviderId(providerId) === normalizedProvider,
        ) ||
        plugin.cliBackends.some(
          (backendId) => normalizeProviderId(backendId) === normalizedProvider,
        ),
    )
    .map((plugin) => plugin.id);

  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveOwningPluginIdsForModelRef(params: {
  model: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] | undefined {
  const parsed = splitExplicitModelRef(params.model);
  if (!parsed) {
    return undefined;
  }

  if (parsed.provider) {
    return resolveOwningPluginIdsForProvider({
      provider: parsed.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      manifestRegistry: params.manifestRegistry,
    });
  }

  const registry = resolveManifestRegistry(params);
  const matchedByPattern = registry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "pattern")
    .map((plugin) => plugin.id);
  const preferredPatternPluginIds = resolvePreferredManifestPluginIds(registry, matchedByPattern);
  if (preferredPatternPluginIds) {
    return preferredPatternPluginIds;
  }

  const matchedByPrefix = registry.plugins
    .filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "prefix")
    .map((plugin) => plugin.id);
  return resolvePreferredManifestPluginIds(registry, matchedByPrefix);
}

export function resolveOwningPluginIdsForModelRefs(params: {
  models: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  const registry = resolveManifestRegistry(params);
  return dedupeSortedPluginIds(
    params.models.flatMap(
      (model) =>
        resolveOwningPluginIdsForModelRef({
          model,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          manifestRegistry: registry,
        }) ?? [],
    ),
  );
}

export function resolveNonBundledProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return registry.plugins
    .filter(
      (plugin) =>
        plugin.origin !== "bundled" &&
        plugin.providers.length > 0 &&
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalizedConfig,
          rootConfig: params.config,
        }).activated,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveCatalogHookProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const enabledProviderPluginIds = registry.plugins
    .filter(
      (plugin) =>
        plugin.providers.length > 0 &&
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalizedConfig,
          rootConfig: params.config,
          enabledByDefault: plugin.enabledByDefault,
        }).activated,
    )
    .map((plugin) => plugin.id);
  const bundledCompatPluginIds = resolveBundledProviderCompatPluginIds(params);
  return [...new Set([...enabledProviderPluginIds, ...bundledCompatPluginIds])].toSorted(
    (left, right) => left.localeCompare(right),
  );
}
