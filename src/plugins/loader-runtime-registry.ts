import { isPluginRegistryLoadInFlight } from "./loader-cache.js";
import {
  hasExplicitCompatibilityInputs,
  resolvePluginLoadCacheContext,
} from "./loader-load-context.js";
import { loadOpenClawPlugins } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
} from "./runtime.js";

function pluginLoadOptionsMatchCacheKey(
  options: PluginLoadOptions,
  expectedCacheKey: string,
): boolean {
  return resolvePluginLoadCacheContext(options).cacheKey === expectedCacheKey;
}

function pluginToolDiscoveryOptionsMatchActiveCacheKey(
  options: PluginLoadOptions,
  expectedCacheKey: string,
): boolean {
  if (options.toolDiscovery !== true) {
    return false;
  }
  const fullRuntimeOptions = { ...options, toolDiscovery: undefined };
  if (pluginLoadOptionsMatchCacheKey(fullRuntimeOptions, expectedCacheKey)) {
    return true;
  }
  if (options.activate !== false) {
    return false;
  }
  return pluginLoadOptionsMatchCacheKey(
    { ...fullRuntimeOptions, activate: true },
    expectedCacheKey,
  );
}

function registryContainsPluginScope(
  registry: PluginRegistry,
  onlyPluginIds: readonly string[] | undefined,
): boolean {
  if (!onlyPluginIds || onlyPluginIds.length === 0) {
    return false;
  }
  const loadedPluginIds = new Set(registry.plugins.map((plugin) => plugin.id));
  return onlyPluginIds.every((pluginId) => loadedPluginIds.has(pluginId));
}

function scopedPluginLoadOptionsMatchWiderActiveCacheKey(
  options: PluginLoadOptions,
  expectedCacheKey: string,
  activeRegistry: PluginRegistry,
): boolean {
  const { onlyPluginIds } = resolvePluginLoadCacheContext(options);
  if (!registryContainsPluginScope(activeRegistry, onlyPluginIds)) {
    return false;
  }
  return pluginLoadOptionsMatchCacheKey({ ...options, onlyPluginIds: undefined }, expectedCacheKey);
}

function getCompatibleActivePluginRegistry(
  options: PluginLoadOptions = {},
): PluginRegistry | undefined {
  if (options.resolveRawConfigEnvVars === true) {
    return undefined;
  }
  const activeRegistry = getActivePluginRegistry() ?? undefined;
  if (!activeRegistry) {
    return undefined;
  }
  if (!hasExplicitCompatibilityInputs(options)) {
    return activeRegistry;
  }
  const activeCacheKey = getActivePluginRegistryKey();
  if (!activeCacheKey) {
    return undefined;
  }
  const loadContext = resolvePluginLoadCacheContext(options);
  const matchesActiveCacheKey = (candidate: PluginLoadOptions): boolean => {
    if (pluginLoadOptionsMatchCacheKey(candidate, activeCacheKey)) {
      return true;
    }
    if (candidate.coreGatewayMethodNames !== undefined) {
      return false;
    }
    return pluginLoadOptionsMatchCacheKey(
      { ...candidate, coreGatewayMethodNames: activeRegistry.coreGatewayMethodNames },
      activeCacheKey,
    );
  };
  const matchesCompatibleActiveRegistry = (candidate: PluginLoadOptions): boolean => {
    if (matchesActiveCacheKey(candidate)) {
      return true;
    }
    if (
      scopedPluginLoadOptionsMatchWiderActiveCacheKey(candidate, activeCacheKey, activeRegistry)
    ) {
      return true;
    }
    return pluginToolDiscoveryOptionsMatchActiveCacheKey(candidate, activeCacheKey);
  };

  if (matchesCompatibleActiveRegistry(options)) {
    return activeRegistry;
  }
  if (!loadContext.shouldActivate) {
    const activatingOptions = { ...options, activate: true };
    if (matchesCompatibleActiveRegistry(activatingOptions)) {
      return activeRegistry;
    }
  }
  const activeRuntimeSubagentMode = getActivePluginRuntimeSubagentMode();
  if (activeRuntimeSubagentMode === "gateway-bindable") {
    const gatewayStartupOptions: PluginLoadOptions = {
      ...options,
      preferBuiltPluginArtifacts: true,
    };
    if (matchesCompatibleActiveRegistry(gatewayStartupOptions)) {
      return activeRegistry;
    }
    if (!loadContext.shouldActivate) {
      const activatingGatewayStartupOptions: PluginLoadOptions = {
        ...options,
        activate: true,
        preferBuiltPluginArtifacts: true,
      };
      if (matchesCompatibleActiveRegistry(activatingGatewayStartupOptions)) {
        return activeRegistry;
      }
    }
  }
  if (
    loadContext.runtimeSubagentMode === "default" &&
    activeRuntimeSubagentMode === "gateway-bindable"
  ) {
    const gatewayBindableOptions: PluginLoadOptions = {
      ...options,
      runtimeOptions: {
        ...options.runtimeOptions,
        allowGatewaySubagentBinding: true,
      },
    };
    const gatewayStartupOptions: PluginLoadOptions = {
      ...gatewayBindableOptions,
      preferBuiltPluginArtifacts: true,
    };
    if (!loadContext.shouldActivate) {
      const activatingGatewayBindableOptions: PluginLoadOptions = {
        ...options,
        activate: true,
        runtimeOptions: {
          ...options.runtimeOptions,
          allowGatewaySubagentBinding: true,
        },
      };
      const activatingGatewayStartupOptions: PluginLoadOptions = {
        ...activatingGatewayBindableOptions,
        preferBuiltPluginArtifacts: true,
      };
      if (
        matchesCompatibleActiveRegistry(gatewayBindableOptions) ||
        matchesCompatibleActiveRegistry(gatewayStartupOptions) ||
        matchesCompatibleActiveRegistry(activatingGatewayBindableOptions) ||
        matchesCompatibleActiveRegistry(activatingGatewayStartupOptions)
      ) {
        return activeRegistry;
      }
    } else if (
      matchesCompatibleActiveRegistry(gatewayBindableOptions) ||
      matchesCompatibleActiveRegistry(gatewayStartupOptions)
    ) {
      return activeRegistry;
    }
  }
  return undefined;
}

export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  if (!options || !hasExplicitCompatibilityInputs(options)) {
    return getCompatibleActivePluginRegistry();
  }
  const compatible = getCompatibleActivePluginRegistry(options);
  if (compatible) {
    return compatible;
  }
  // Runtime helpers must not recurse while this exact snapshot is registering.
  // Direct loadOpenClawPlugins callers still surface the hard error.
  if (isPluginRegistryLoadInFlight(options)) {
    return undefined;
  }
  return loadOpenClawPlugins(options);
}

export function getRuntimePluginRegistryForLoadOptions(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  return resolveRuntimePluginRegistry(options);
}

/** Return a compatible active registry without triggering a fresh load on cache miss. */
export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  return getCompatibleActivePluginRegistry(options);
}
