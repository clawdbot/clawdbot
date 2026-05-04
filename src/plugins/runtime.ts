import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
} from "./host-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  PLUGIN_REGISTRY_STATE,
  type RegistryState,
  type RegistrySurfaceState,
} from "./runtime-state.js";

const log = createSubsystemLogger("plugins/runtime");

function asPluginRegistry(registry: RegistryState["activeRegistry"]): PluginRegistry | null {
  return registry;
}

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [PLUGIN_REGISTRY_STATE]?: RegistryState;
  };
  let registryState = globalState[PLUGIN_REGISTRY_STATE];
  if (!registryState) {
    registryState = {
      activeRegistry: null,
      activeVersion: 0,
      httpRoute: {
        registry: null,
        pinned: false,
        version: 0,
      },
      channel: {
        registry: null,
        pinned: false,
        version: 0,
      },
      key: null,
      workspaceDir: null,
      runtimeSubagentMode: "default",
      importedPluginIds: new Set<string>(),
    };
    globalState[PLUGIN_REGISTRY_STATE] = registryState;
  }
  return registryState;
})();

let pluginAgentEventUnsubscribe: (() => void) | undefined;

function registryHasPluginHostCleanupWork(registry: PluginRegistry | null): boolean {
  if (!registry) {
    return false;
  }
  return (
    registry.plugins.some((plugin) => plugin.status === "loaded") ||
    (registry.sessionExtensions?.length ?? 0) > 0 ||
    (registry.runtimeLifecycles?.length ?? 0) > 0 ||
    (registry.agentEventSubscriptions?.length ?? 0) > 0 ||
    (registry.sessionSchedulerJobs?.length ?? 0) > 0
  );
}

async function cleanupPreviousPluginHostRegistry(params: {
  previousRegistry: PluginRegistry;
}): Promise<void> {
  const [{ getRuntimeConfig }, { cleanupReplacedPluginHostRegistry }] = await Promise.all([
    import("../config/config.js"),
    import("./host-hook-cleanup.js"),
  ]);
  const nextRegistry = asPluginRegistry(state.activeRegistry);
  if (!nextRegistry || nextRegistry === params.previousRegistry) {
    return;
  }
  // Async cleanup must not clear state for a registry that has been restored
  // active, but later swaps should not strand cleanup for the retiring registry.
  const shouldCleanup = () => state.activeRegistry !== params.previousRegistry;
  await cleanupReplacedPluginHostRegistry({
    cfg: getRuntimeConfig(),
    previousRegistry: params.previousRegistry,
    nextRegistry,
    shouldCleanup,
  });
}

function syncPluginAgentEventBridge(registry: PluginRegistry | null): void {
  pluginAgentEventUnsubscribe?.();
  pluginAgentEventUnsubscribe = undefined;
  if (!registry) {
    return;
  }
  pluginAgentEventUnsubscribe = onAgentEvent((event) => {
    dispatchPluginAgentEventSubscriptions({ registry: state.activeRegistry, event });
  });
}

export function recordImportedPluginId(pluginId: string): void {
  state.importedPluginIds.add(pluginId);
}

function installSurfaceRegistry(
  surface: RegistrySurfaceState,
  registry: RegistryState["activeRegistry"],
  pinned: boolean,
) {
  if (surface.registry === registry && surface.pinned === pinned) {
    return;
  }
  surface.registry = registry;
  surface.pinned = pinned;
  surface.version += 1;
}

function syncTrackedSurface(
  surface: RegistrySurfaceState,
  registry: RegistryState["activeRegistry"],
  refreshVersion = false,
) {
  if (surface.pinned) {
    return;
  }
  if (surface.registry === registry && !surface.pinned) {
    if (refreshVersion) {
      surface.version += 1;
    }
    return;
  }
  installSurfaceRegistry(surface, registry, false);
}

export function setActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey?: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable" = "default",
  workspaceDir?: string,
) {
  const previousRegistry = asPluginRegistry(state.activeRegistry);
  if (previousRegistry && previousRegistry !== registry) {
    markPluginRegistryRetired(previousRegistry);
  }
  markPluginRegistryActive(registry);
  state.activeRegistry = registry;
  state.activeVersion += 1;
  syncTrackedSurface(state.httpRoute, registry, true);
  syncTrackedSurface(state.channel, registry, true);
  state.key = cacheKey ?? null;
  state.workspaceDir = workspaceDir ?? null;
  state.runtimeSubagentMode = runtimeSubagentMode;
  syncPluginAgentEventBridge(registry);
  if (
    !previousRegistry ||
    previousRegistry === registry ||
    !registryHasPluginHostCleanupWork(previousRegistry)
  ) {
    return;
  }
  void cleanupPreviousPluginHostRegistry({
    previousRegistry,
  }).catch((error) => {
    log.warn(`plugin host registry cleanup failed: ${String(error)}`);
  });
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.activeRegistry);
}

export function getActivePluginRegistryWorkspaceDir(): string | undefined {
  return state.workspaceDir ?? undefined;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.activeRegistry) {
    state.activeRegistry = createEmptyPluginRegistry();
    state.activeVersion += 1;
    syncTrackedSurface(state.httpRoute, state.activeRegistry);
    syncTrackedSurface(state.channel, state.activeRegistry);
  }
  return asPluginRegistry(state.activeRegistry)!;
}

export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  installSurfaceRegistry(state.httpRoute, registry, true);
}

export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRoute.registry !== registry) {
    return;
  }
  installSurfaceRegistry(state.httpRoute, state.activeRegistry, false);
}

export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.httpRoute.registry ?? state.activeRegistry);
}

export function getActivePluginHttpRouteRegistryVersion(): number {
  return state.httpRoute.registry ? state.httpRoute.version : state.activeVersion;
}

export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  installSurfaceRegistry(state.httpRoute, created, false);
  return created;
}

export function resolveActivePluginHttpRouteRegistry(fallback: PluginRegistry): PluginRegistry {
  const routeRegistry = getActivePluginHttpRouteRegistry();
  if (!routeRegistry) {
    return fallback;
  }
  if (state.httpRoute.pinned) {
    return routeRegistry;
  }
  const routeCount = routeRegistry.httpRoutes?.length ?? 0;
  const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
  if (routeCount === 0 && fallbackRouteCount > 0) {
    return fallback;
  }
  return routeRegistry;
}

/** Pin the channel registry so that subsequent `setActivePluginRegistry` calls
 *  do not replace the channel snapshot used by `getChannelPlugin`. Call at
 *  gateway startup after the initial plugin load so that config-schema reads
 *  and other non-primary registry loads cannot evict channel plugins. */
export function pinActivePluginChannelRegistry(registry: PluginRegistry) {
  installSurfaceRegistry(state.channel, registry, true);
}

export function releasePinnedPluginChannelRegistry(registry?: PluginRegistry) {
  if (registry && state.channel.registry !== registry) {
    return;
  }
  installSurfaceRegistry(state.channel, state.activeRegistry, false);
}

/** Return the registry that should be used for channel plugin resolution.
 *  When pinned, this returns the startup registry regardless of subsequent
 *  `setActivePluginRegistry` calls. */
export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.channel.registry ?? state.activeRegistry);
}

export function getActivePluginChannelRegistryVersion(): number {
  return state.channel.registry ? state.channel.version : state.activeVersion;
}

export function requireActivePluginChannelRegistry(): PluginRegistry {
  const existing = getActivePluginChannelRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  installSurfaceRegistry(state.channel, created, false);
  return created;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRuntimeSubagentMode(): "default" | "explicit" | "gateway-bindable" {
  return state.runtimeSubagentMode;
}

export function getActivePluginRegistryVersion(): number {
  return state.activeVersion;
}

function collectLoadedPluginIds(
  registry: PluginRegistry | null | undefined,
  ids: Set<string>,
): void {
  if (!registry) {
    return;
  }
  for (const plugin of registry.plugins) {
    if (plugin.status === "loaded" && plugin.format !== "bundle") {
      ids.add(plugin.id);
    }
  }
}

/**
 * Returns plugin ids that were imported by plugin runtime or registry loading in
 * the current process.
 *
 * This is a process-level view, not a fresh import trace: cached registry reuse
 * still counts because the plugin code was loaded earlier in this process.
 * Explicit loader import tracking covers plugins that were imported but later
 * ended in an error state during registration.
 * Bundle-format plugins are excluded because they can be "loaded" from metadata
 * without importing any JS entrypoint.
 */
export function listImportedRuntimePluginIds(): string[] {
  const imported = new Set(state.importedPluginIds);
  collectLoadedPluginIds(asPluginRegistry(state.activeRegistry), imported);
  collectLoadedPluginIds(asPluginRegistry(state.channel.registry), imported);
  collectLoadedPluginIds(asPluginRegistry(state.httpRoute.registry), imported);
  return [...imported].toSorted((left, right) => left.localeCompare(right));
}

export function resetPluginRuntimeStateForTest(): void {
  state.activeRegistry = null;
  state.activeVersion += 1;
  installSurfaceRegistry(state.httpRoute, null, false);
  installSurfaceRegistry(state.channel, null, false);
  state.key = null;
  state.workspaceDir = null;
  state.runtimeSubagentMode = "default";
  state.importedPluginIds.clear();
  syncPluginAgentEventBridge(null);
  // Also clear the plugin host-hook runtime singleton (run context map,
  // scheduler-job records, pending agent-event handlers, closedRunIds set).
  // Otherwise per-test bleed-over of those globals can cause flaky behavior
  // since this helper is widely used across plugin/agent tests.
  clearPluginHostRuntimeState();
}
