// Stores active runtime plugin registry state and activation metadata.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveCompatibleRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  collectLivePluginRegistries,
  getActivePluginChannelRegistry,
  getActivePluginHttpRouteRegistry,
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
} from "./runtime.js";

export type ActiveRuntimePluginRegistrySurface = "active" | "channel" | "http-route";

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getActivePluginRegistry();
}

function isRuntimePluginRecordLoaded(plugin: PluginRecord): boolean {
  return plugin.status === "loaded" && (plugin.format === "bundle" || plugin.imported !== false);
}

// Plugin ids confirmed loaded across every live runtime registry surface
// (active plus any pinned http-route/channel/session-extension registry), via
// the canonical collectLivePluginRegistries() set. A plugin can stay live via a
// pinned surface that diverged from the active registry, so reading "loaded"
// from the active registry alone would mislabel it. No-op when the surfaces are
// synced to the active registry (the common case).
export function listLoadedRuntimePluginIdsAcrossSurfaces(): string[] {
  const loaded: string[] = [];
  for (const registry of collectLivePluginRegistries()) {
    for (const plugin of registry.plugins ?? []) {
      if (isRuntimePluginRecordLoaded(plugin)) {
        loaded.push(plugin.id);
      }
    }
  }
  return normalizeSortedUniqueStringEntries(loaded);
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
  const present = new Set<string>();
  const loaded = new Set<string>();
  const pluginStatusById = new Map<string, string | undefined>();
  const pluginRuntimeLoadedById = new Map<string, boolean>();
  for (const plugin of registry.plugins ?? []) {
    present.add(plugin.id);
    pluginStatusById.set(plugin.id, plugin.status);
    pluginRuntimeLoadedById.set(plugin.id, isRuntimePluginRecordLoaded(plugin));
    // Deferred manifest records are metadata-only until their runtime module is
    // imported. Reusing them here would skip the scoped load that registers the
    // requested harness/provider/tool capabilities.
    if (plugin.status === undefined || isRuntimePluginRecordLoaded(plugin)) {
      loaded.add(plugin.id);
    }
  }
  for (const [key, value] of Object.entries(registry)) {
    if (key === "diagnostics" || key === "channelSetups") {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (entry && typeof entry === "object" && "pluginId" in entry) {
        const pluginId = entry.pluginId;
        if (typeof pluginId === "string" && pluginId.length > 0) {
          present.add(pluginId);
          const status = pluginStatusById.get(pluginId);
          if (status === undefined || pluginRuntimeLoadedById.get(pluginId) === true) {
            loaded.add(pluginId);
          }
        }
      }
    }
  }
  if (pluginIds.length === 0) {
    return present.size === 0;
  }
  return pluginIds.every((pluginId) => loaded.has(pluginId));
}

function resolveSurfaceRegistry(
  surface: ActiveRuntimePluginRegistrySurface,
): PluginRegistry | null {
  switch (surface) {
    case "active":
      return getActivePluginRegistry();
    case "channel":
      return getActivePluginChannelRegistry();
    case "http-route":
      return getActivePluginHttpRouteRegistry();
  }
  return null;
}

export function getLoadedRuntimePluginRegistry(
  params: {
    env?: NodeJS.ProcessEnv;
    loadOptions?: PluginLoadOptions;
    workspaceDir?: string;
    requiredPluginIds?: readonly string[];
    surface?: ActiveRuntimePluginRegistrySurface;
  } = {},
): PluginRegistry | undefined {
  const surface = params.surface ?? "active";
  const requiredPluginIds = normalizeRequiredPluginIds(
    params.requiredPluginIds ?? params.loadOptions?.onlyPluginIds,
  );
  if (surface === "active" && params.loadOptions && requiredPluginIds?.length !== 0) {
    const compatible = resolveCompatibleRuntimePluginRegistry(params.loadOptions);
    if (!compatible || !registryContainsRuntimePluginIds(compatible, requiredPluginIds)) {
      return undefined;
    }
    return compatible;
  }

  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  const requestedWorkspaceDir = params.workspaceDir ?? params.loadOptions?.workspaceDir;
  if (requestedWorkspaceDir !== undefined && activeWorkspaceDir !== requestedWorkspaceDir) {
    return undefined;
  }
  const registry = resolveSurfaceRegistry(surface);
  if (!registry) {
    return undefined;
  }
  if (!registryContainsRuntimePluginIds(registry, requiredPluginIds)) {
    return undefined;
  }
  return registry;
}
