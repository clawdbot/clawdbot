// Runtime registry loader entry points distinguish process-root installation from scoped handles.
import {
  type ActiveRuntimePluginRegistrySurface,
  getLoadedRuntimePluginRegistry,
} from "../active-runtime-registry.js";
import {
  loadAndActivateRootPluginRegistry,
  loadPluginRegistryHandle,
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

function installProcessRootRuntimePluginRegistry(
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

type RuntimePluginRegistryLoadParams = {
  loadOptions: PluginLoadOptions;
  forceLoad?: boolean;
  requiredPluginIds?: readonly string[];
  surface?: ActiveRuntimePluginRegistrySurface;
};

function findLoadedRuntimePluginRegistry(
  params: RuntimePluginRegistryLoadParams,
): PluginRegistry | undefined {
  if (params.loadOptions.onlyPluginIds?.length === 0) {
    return undefined;
  }
  const requiredPluginIds = params.requiredPluginIds ?? params.loadOptions.onlyPluginIds;
  const surface = params.surface ?? "active";
  if (!params.forceLoad) {
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
  }

  return undefined;
}

/** Builds or reuses a registry value without changing any process-wide active surface. */
export function loadRuntimePluginRegistryHandle(
  params: RuntimePluginRegistryLoadParams,
): PluginRegistry | undefined {
  const loadOptions = { ...params.loadOptions, activate: false };
  return (
    findLoadedRuntimePluginRegistry({ ...params, loadOptions }) ??
    loadPluginRegistryHandle(params.forceLoad ? { ...loadOptions, cache: false } : loadOptions)
  );
}

/** Installs a registry from a process composition root. Never call from request/run scope. */
export function installRuntimePluginRegistryAtProcessRoot(
  params: RuntimePluginRegistryLoadParams,
): PluginRegistry | undefined {
  const loadOptions = { ...params.loadOptions, activate: true };
  const registry =
    findLoadedRuntimePluginRegistry({ ...params, loadOptions }) ??
    loadAndActivateRootPluginRegistry(
      params.forceLoad ? { ...loadOptions, cache: false } : loadOptions,
    );
  const surface = params.surface ?? "active";
  if (surface === "active") {
    return registry;
  }
  installProcessRootRuntimePluginRegistry(registry, {
    loadOptions,
    surface,
  });
  return registry;
}
