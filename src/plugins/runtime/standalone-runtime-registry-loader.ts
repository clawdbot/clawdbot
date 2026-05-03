import {
  type ActiveRuntimePluginRegistrySurface,
  getLoadedRuntimePluginRegistry,
} from "../active-runtime-registry.js";
import {
  loadOpenClawPlugins,
  resolvePluginRegistryLoadCacheKey,
  type PluginLoadOptions,
} from "../loader.js";
import type { PluginRegistry } from "../registry-types.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../runtime.js";

function resolveRuntimeSubagentMode(
  loadOptions: PluginLoadOptions,
): "default" | "explicit" | "gateway-bindable" {
  if (loadOptions.runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  if (loadOptions.runtimeOptions?.subagent) {
    return "explicit";
  }
  return "default";
}

function installStandaloneRegistry(
  registry: PluginRegistry,
  params: {
    loadOptions: PluginLoadOptions;
    surface: ActiveRuntimePluginRegistrySurface;
  },
): void {
  const cacheKey = resolvePluginRegistryLoadCacheKey(params.loadOptions);
  const mode = resolveRuntimeSubagentMode(params.loadOptions);
  setActivePluginRegistry(registry, cacheKey, mode, params.loadOptions.workspaceDir);
  switch (params.surface) {
    case "active":
      break;
    case "channel":
      pinActivePluginChannelRegistry(registry);
      break;
    case "http-route":
      pinActivePluginHttpRouteRegistry(registry);
      break;
  }
}

export function ensureStandaloneRuntimePluginRegistryLoaded(params: {
  loadOptions: PluginLoadOptions;
  requiredPluginIds?: readonly string[];
  surface?: ActiveRuntimePluginRegistrySurface;
}): PluginRegistry | undefined {
  const requiredPluginIds = params.requiredPluginIds ?? params.loadOptions.onlyPluginIds;
  const surface = params.surface ?? "active";
  const existing = getLoadedRuntimePluginRegistry({
    env: params.loadOptions.env,
    loadOptions: params.loadOptions,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds,
    surface,
  });
  if (existing) {
    return existing;
  }

  const registry = loadOpenClawPlugins(params.loadOptions);
  if (params.loadOptions.activate !== false) {
    switch (surface) {
      case "active":
        break;
      case "channel":
        pinActivePluginChannelRegistry(registry);
        break;
      case "http-route":
        pinActivePluginHttpRouteRegistry(registry);
        break;
    }
    return registry;
  }

  installStandaloneRegistry(registry, {
    loadOptions: params.loadOptions,
    surface,
  });
  return registry;
}
