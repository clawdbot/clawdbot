// Coordinates active plugin runtime registries and event hooks.
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
} from "./host-hook-runtime.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { settlePreparedMessageToolCatalog } from "./prepared-message-tool-catalog.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginChannelRegistrySnapshotFromState } from "./runtime-channel-state.js";
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
      sessionExtension: {
        registry: null,
        pinned: false,
        version: 0,
      },
      agentEventBridgeUnsubscribe: undefined,
      key: null,
      workspaceDir: null,
      runtimeSubagentMode: "default",
      importedPluginIds: new Set<string>(),
    };
    globalState[PLUGIN_REGISTRY_STATE] = registryState;
  }
  return registryState;
})();

function registryHasPluginHostCleanupWork(registry: PluginRegistry | null): boolean {
  if (!registry) {
    return false;
  }
  return (
    registry.plugins.some((plugin) => plugin.status === "loaded") ||
    registry.sessionExtensions.length > 0 ||
    registry.runtimeLifecycles.length > 0 ||
    registry.agentEventSubscriptions.length > 0 ||
    registry.sessionSchedulerJobs.length > 0
  );
}

function isRegistryPinned(registry: PluginRegistry): boolean {
  return (
    (state.httpRoute.pinned && state.httpRoute.registry === registry) ||
    (state.channel.pinned && state.channel.registry === registry) ||
    (state.sessionExtension.pinned && state.sessionExtension.registry === registry)
  );
}

function isRegistryLive(registry: PluginRegistry): boolean {
  return state.activeRegistry === registry || isRegistryPinned(registry);
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

function cleanupRetiredPluginHostRegistry(previousRegistry: PluginRegistry): void {
  if (!registryHasPluginHostCleanupWork(previousRegistry)) {
    return;
  }
  void cleanupPreviousPluginHostRegistry({
    previousRegistry,
  }).catch((error: unknown) => {
    log.warn(`plugin host registry cleanup failed: ${String(error)}`);
  });
}

function retirePluginRegistryIfUnused(registry: PluginRegistry | null): boolean {
  if (!registry || isRegistryLive(registry)) {
    return false;
  }
  markPluginRegistryRetired(registry);
  return true;
}

/**
 * Returns the distinct live plugin registries in precedence order: the active
 * registry first, then the pinned http-route and channel surfaces. Uses the
 * raw pinned registries (not channel-presentation selection) so a pinned
 * registry stays visible to runtime dispatch even with zero channels. Shared
 * by the agent-event bridge and the global hook runner so both dispatch
 * surfaces agree on what "live" means.
 */
export function collectLivePluginRegistries(): PluginRegistry[] {
  const registries: PluginRegistry[] = [];
  const seen = new Set<PluginRegistry>();
  const addRegistry = (registry: PluginRegistry | null) => {
    if (!registry || seen.has(registry)) {
      return;
    }
    seen.add(registry);
    registries.push(registry);
  };
  addRegistry(asPluginRegistry(state.activeRegistry));
  addRegistry(asPluginRegistry(state.httpRoute.registry));
  addRegistry(asPluginRegistry(state.channel.registry));
  addRegistry(asPluginRegistry(state.sessionExtension.registry));
  return registries;
}

function syncPluginAgentEventBridge(): void {
  state.agentEventBridgeUnsubscribe?.();
  state.agentEventBridgeUnsubscribe = undefined;
  if (collectLivePluginRegistries().length === 0) {
    return;
  }
  state.agentEventBridgeUnsubscribe = onAgentEvent((event) => {
    for (const registry of collectLivePluginRegistries()) {
      dispatchPluginAgentEventSubscriptions({ registry, event });
    }
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
  state.activeRegistry = registry;
  markPluginRegistryActive(registry);
  state.activeVersion += 1;
  syncTrackedSurface(state.httpRoute, registry, true);
  syncTrackedSurface(state.channel, registry, true);
  settlePreparedMessageToolCatalog(
    registry,
    state.channel.pinned ? state.activeVersion : state.channel.version,
  );
  syncTrackedSurface(state.sessionExtension, registry, true);
  state.key = cacheKey ?? null;
  state.workspaceDir = workspaceDir ?? null;
  state.runtimeSubagentMode = runtimeSubagentMode;
  syncPluginAgentEventBridge();
  if (!previousRegistry || previousRegistry === registry) {
    return;
  }
  if (!retirePluginRegistryIfUnused(previousRegistry)) {
    return;
  }
  cleanupRetiredPluginHostRegistry(previousRegistry);
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
    markPluginRegistryActive(state.activeRegistry);
    state.activeVersion += 1;
    syncTrackedSurface(state.httpRoute, state.activeRegistry);
    syncTrackedSurface(state.channel, state.activeRegistry);
    settlePreparedMessageToolCatalog(state.activeRegistry, state.channel.version);
    syncTrackedSurface(state.sessionExtension, state.activeRegistry);
  }
  return asPluginRegistry(state.activeRegistry)!;
}

export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  const previousRegistry = asPluginRegistry(state.httpRoute.registry);
  installSurfaceRegistry(state.httpRoute, registry, true);
  markPluginRegistryActive(registry);
  syncPluginAgentEventBridge();
  if (retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
}

export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRoute.registry !== registry) {
    return;
  }
  const previousRegistry = asPluginRegistry(state.httpRoute.registry);
  installSurfaceRegistry(state.httpRoute, state.activeRegistry, false);
  syncPluginAgentEventBridge();
  if (retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
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

export function pinActivePluginChannelRegistry(registry: PluginRegistry) {
  const previousRegistry = asPluginRegistry(state.channel.registry);
  installSurfaceRegistry(state.channel, registry, true);
  settlePreparedMessageToolCatalog();
  markPluginRegistryActive(registry);
  syncPluginAgentEventBridge();
  if (retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
}

export function releasePinnedPluginChannelRegistry(registry?: PluginRegistry) {
  if (registry && state.channel.registry !== registry) {
    return;
  }
  const previousRegistry = asPluginRegistry(state.channel.registry);
  installSurfaceRegistry(state.channel, state.activeRegistry, false);
  settlePreparedMessageToolCatalog();
  syncPluginAgentEventBridge();
  if (retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
}

export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return getActivePluginChannelRegistrySnapshotFromState().registry as PluginRegistry | null;
}

export function getActivePluginChannelRegistryVersion(): number {
  return getActivePluginChannelRegistrySnapshotFromState().version;
}

function countCommandChannelSurface(registry: PluginRegistry | null): number {
  return (registry?.commands.length ?? 0) + (registry?.channels.length ?? 0);
}

export function getActivePluginGatewayCommandRegistry(): PluginRegistry | null {
  const pinnedChannelRegistry = state.channel.pinned
    ? asPluginRegistry(state.channel.registry)
    : null;
  const pinnedHttpRouteRegistry = state.httpRoute.pinned
    ? asPluginRegistry(state.httpRoute.registry)
    : null;
  const activeRegistry = asPluginRegistry(state.activeRegistry);
  const pinnedRegistry =
    (countCommandChannelSurface(pinnedChannelRegistry) > 0 ? pinnedChannelRegistry : null) ??
    (countCommandChannelSurface(pinnedHttpRouteRegistry) > 0 ? pinnedHttpRouteRegistry : null);
  if (pinnedRegistry) {
    return pinnedRegistry;
  }
  if (activeRegistry && countCommandChannelSurface(activeRegistry) > 0) {
    return activeRegistry;
  }
  return pinnedChannelRegistry ?? pinnedHttpRouteRegistry ?? activeRegistry;
}

export function getActivePluginGatewayNodePolicyRegistry(): PluginRegistry | null {
  // Node allowlists and invoke guards are Gateway security policy. Agent-scoped
  // registry swaps must not add commands or shadow the pinned startup policy.
  return (
    (state.channel.pinned ? asPluginRegistry(state.channel.registry) : null) ??
    (state.httpRoute.pinned ? asPluginRegistry(state.httpRoute.registry) : null) ??
    (state.sessionExtension.pinned ? asPluginRegistry(state.sessionExtension.registry) : null) ??
    asPluginRegistry(state.activeRegistry)
  );
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

export function pinActivePluginSessionExtensionRegistry(registry: PluginRegistry) {
  const previousRegistry = asPluginRegistry(state.sessionExtension.registry);
  installSurfaceRegistry(state.sessionExtension, registry, true);
  markPluginRegistryActive(registry);
  syncPluginAgentEventBridge();
  if (retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
}

export function releasePinnedPluginSessionExtensionRegistry(registry?: PluginRegistry) {
  if (registry && state.sessionExtension.registry !== registry) {
    return;
  }
  const previousRegistry = asPluginRegistry(state.sessionExtension.registry);
  installSurfaceRegistry(state.sessionExtension, state.activeRegistry, false);
  syncPluginAgentEventBridge();
  if (retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
}

export function getActivePluginSessionExtensionRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.sessionExtension.registry ?? state.activeRegistry);
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
  collectLoadedPluginIds(asPluginRegistry(state.sessionExtension.registry), imported);
  return [...imported].toSorted((left, right) => left.localeCompare(right));
}

export function resetPluginRuntimeStateForTest(): void {
  state.activeRegistry = null;
  state.activeVersion += 1;
  installSurfaceRegistry(state.httpRoute, null, false);
  installSurfaceRegistry(state.channel, null, false);
  settlePreparedMessageToolCatalog();
  installSurfaceRegistry(state.sessionExtension, null, false);
  state.key = null;
  state.workspaceDir = null;
  state.runtimeSubagentMode = "default";
  state.importedPluginIds.clear();
  syncPluginAgentEventBridge();
  // Also clear the plugin host-hook runtime singleton (run context map,
  // scheduler-job records, pending agent-event handlers, closedRunIds set).
  // Otherwise per-test bleed-over of those globals can cause flaky behavior
  // since this helper is widely used across plugin/agent tests.
  clearPluginHostRuntimeState();
  clearPluginMetadataLifecycleCaches();
}
