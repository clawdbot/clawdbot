// Stores active runtime plugin registry state and activation metadata.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryWorkspaceDir,
} from "./runtime.js";

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getActivePluginRegistry();
}

/** Return the exact active registry without triggering a fresh load on cache miss. */
export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  const activeRegistry = getActivePluginRegistry() ?? undefined;
  if (!activeRegistry || options === undefined) {
    return activeRegistry;
  }
  const activeCacheKey = getActivePluginRegistryKey();
  if (!activeCacheKey) {
    return undefined;
  }
  return resolvePluginLoadCacheContext(options).cacheKey === activeCacheKey
    ? activeRegistry
    : undefined;
}

function isRuntimePluginRecordLoaded(plugin: PluginRecord): boolean {
  return plugin.status === "loaded" && (plugin.format === "bundle" || plugin.imported !== false);
}

/** Lists runtime-loaded plugin ids from an immutable/request-scoped registry handle. */
export function listRuntimePluginIdsFromRegistry(registry: PluginRegistry): string[] {
  return normalizeSortedUniqueStringEntries(
    registry.plugins.filter(isRuntimePluginRecordLoaded).map((plugin) => plugin.id),
  );
}

export function listLoadedRuntimePluginIds(): string[] {
  const registry = getActivePluginRegistry();
  return registry ? listRuntimePluginIdsFromRegistry(registry) : [];
}

function normalizeRequiredPluginIds(ids?: readonly string[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return normalizeSortedUniqueStringEntries(ids);
}

export function registryContainsRuntimePluginIds(
  registry: PluginRegistry,
  pluginIds: readonly string[] | undefined,
): boolean {
  if (pluginIds === undefined) {
    return true;
  }
  if (pluginIds.length === 0 && registry.plugins.length > 0) {
    return false;
  }
  const missing = new Set(pluginIds);
  for (const plugin of registry.plugins) {
    if (plugin.status === undefined || isRuntimePluginRecordLoaded(plugin)) {
      missing.delete(plugin.id);
    }
  }
  if (pluginIds.length > 0 && missing.size === 0) {
    return true;
  }
  // Loader records decide runtime availability. Direct SDK registrations can
  // lack a record, but must never revive a disabled, failed, or deferred owner.
  if (registry.plugins.some((plugin) => missing.has(plugin.id))) {
    return false;
  }
  for (const [key, value] of Object.entries(registry)) {
    if (key === "diagnostics" || key === "channelSetups" || !Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (entry && typeof entry === "object" && "pluginId" in entry) {
        const pluginId = entry.pluginId;
        if (typeof pluginId === "string" && pluginId.length > 0) {
          if (pluginIds.length === 0) {
            return false;
          }
          missing.delete(pluginId);
          if (missing.size === 0) {
            return true;
          }
        }
      }
    }
  }
  return pluginIds.length === 0;
}

export function registryMatchesManifestPluginIds(
  registry: PluginRegistry,
  manifestPlugins: readonly PluginManifestRecord[] | undefined,
  pluginIds: readonly string[],
): boolean {
  if (!manifestPlugins) {
    return false;
  }
  const records = new Map(registry.plugins.map((plugin) => [plugin.id, plugin]));
  const manifests = new Map(manifestPlugins.map((plugin) => [plugin.id, plugin]));
  return pluginIds.every((pluginId) => {
    const record = records.get(pluginId);
    const manifest = manifests.get(pluginId);
    return Boolean(
      record &&
      manifest &&
      record.origin === manifest.origin &&
      (record.origin === "bundled" ||
        (record.rootDir === manifest.rootDir && record.source === manifest.source)),
    );
  });
}

export function getLoadedRuntimePluginRegistry(
  params: {
    env?: NodeJS.ProcessEnv;
    loadOptions?: PluginLoadOptions;
    workspaceDir?: string;
    requiredPluginIds?: readonly string[];
  } = {},
): PluginRegistry | undefined {
  const requiredPluginIds = normalizeRequiredPluginIds(
    params.requiredPluginIds ?? params.loadOptions?.onlyPluginIds,
  );
  if (params.loadOptions && requiredPluginIds === undefined) {
    // Explicit scopes below are bounded by workspace and loaded owners. Only
    // unscoped requests need the full load identity to prove compatible reuse.
    return resolveCompatibleRuntimePluginRegistry(params.loadOptions);
  }

  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  const requestedWorkspaceDir = params.workspaceDir ?? params.loadOptions?.workspaceDir;
  if (requestedWorkspaceDir !== undefined && activeWorkspaceDir !== requestedWorkspaceDir) {
    return undefined;
  }
  const registry = getActivePluginRegistry();
  if (!registry) {
    return undefined;
  }
  if (!registryContainsRuntimePluginIds(registry, requiredPluginIds)) {
    return undefined;
  }
  return registry;
}
