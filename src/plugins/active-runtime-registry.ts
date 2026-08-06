// Stores active runtime plugin registry state and activation metadata.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveCompatibleRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry, getActivePluginRegistryWorkspaceDir } from "./runtime.js";

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return getActivePluginRegistry();
}

function isRuntimePluginRecordLoaded(plugin: PluginRecord): boolean {
  return plugin.status === "loaded" && (plugin.format === "bundle" || plugin.imported !== false);
}

export function listLoadedRuntimePluginIds(): string[] {
  return normalizeSortedUniqueStringEntries(
    (getActivePluginRegistry()?.plugins ?? [])
      .filter(isRuntimePluginRecordLoaded)
      .map((plugin) => plugin.id),
  );
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
  const registry = getActivePluginRegistry();
  if (!registry) {
    return undefined;
  }
  if (!registryContainsRuntimePluginIds(registry, requiredPluginIds)) {
    return undefined;
  }
  return registry;
}
