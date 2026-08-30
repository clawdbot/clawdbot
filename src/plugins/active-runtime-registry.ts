// Stores active runtime plugin registry state and activation metadata.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveCompatibleRuntimePluginRegistry } from "./loader-cache.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  getPluginRegistryState,
} from "./runtime-state.js";

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getPluginRegistryState()?.activeRegistry ?? null;
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
  const registry = getActiveRuntimePluginRegistry();
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
  if (params.loadOptions && requiredPluginIds?.length !== 0) {
    const compatible = resolveCompatibleRuntimePluginRegistry(params.loadOptions);
    if (compatible && registryContainsRuntimePluginIds(compatible, requiredPluginIds)) {
      return compatible;
    }
    // Exact cache-key reuse fails for every caller whose options differ from the
    // composition root's load (scoped ids, derived config, no gateway bindings),
    // which used to force a cold scoped load even when the active registry already
    // holds the requested runtime plugins. An explicit id list proves what the
    // caller needs, so fall through to the containment check below; unscoped
    // requests keep exact-key semantics because no id list bounds their intent.
    if (requiredPluginIds === undefined) {
      return undefined;
    }
  }

  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const requestedWorkspaceDir = params.workspaceDir ?? params.loadOptions?.workspaceDir;
  if (requestedWorkspaceDir !== undefined && activeWorkspaceDir !== requestedWorkspaceDir) {
    return undefined;
  }
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    return undefined;
  }
  if (!registryContainsRuntimePluginIds(registry, requiredPluginIds)) {
    return undefined;
  }
  return registry;
}
