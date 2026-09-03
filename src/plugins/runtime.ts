// Coordinates active plugin runtime registries and event hooks.
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  getPluginCommandExecutionCount,
  isPluginCommandExecutionActiveHere,
  waitForPluginCommandExecutions,
} from "./command-execution-lock.js";
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
import { PLUGIN_REGISTRY_STATE, type RegistryState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

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

function isRegistryLive(registry: PluginRegistry): boolean {
  return state.activeRegistry === registry;
}

const loadPluginHostCleanupRuntime = createLazyRuntimeModule(async () => {
  const [{ getRuntimeConfig }, { cleanupReplacedPluginHostRegistry }] = await Promise.all([
    import("../config/config.js"),
    import("./host-hook-cleanup.js"),
  ]);
  return { getRuntimeConfig, cleanupReplacedPluginHostRegistry };
});

async function cleanupPreviousPluginHostRegistry(params: {
  previousRegistry: PluginRegistry;
}): Promise<void> {
  const { getRuntimeConfig, cleanupReplacedPluginHostRegistry } =
    await loadPluginHostCleanupRuntime();
  const nextRegistry = asPluginRegistry(state.activeRegistry);
  if (nextRegistry === params.previousRegistry) {
    return;
  }
  // Async cleanup must not clear state for a registry that has been restored
  // active, but later swaps should not strand cleanup for the retiring registry.
  const shouldCleanup = () => state.activeRegistry !== params.previousRegistry;
  const { failures } = await cleanupReplacedPluginHostRegistry({
    cfg: getRuntimeConfig(),
    previousRegistry: params.previousRegistry,
    nextRegistry,
    shouldCleanup,
  });
  // Per-hook cleanup errors are collected instead of thrown (host-hook-cleanup
  // must finish every plugin); dropping them here would hide broken
  // session-extension/scheduler teardown from operators entirely.
  for (const failure of failures) {
    log.warn(
      `plugin host cleanup failed for ${failure.pluginId} hook ${failure.hookId}: ${String(failure.error)}`,
    );
  }
}

function cleanupRetiredPluginHostRegistry(previousRegistry: PluginRegistry): void {
  if (!registryHasPluginHostCleanupWork(previousRegistry)) {
    return;
  }
  const cleanup = () =>
    cleanupPreviousPluginHostRegistry({ previousRegistry }).catch((error: unknown) => {
      log.warn(`plugin host registry cleanup failed: ${String(error)}`);
    });
  if (getPluginCommandExecutionCount(previousRegistry) > 0) {
    void waitForPluginCommandExecutions(previousRegistry).then(cleanup);
    return;
  }
  void cleanup();
}

function retirePluginRegistryIfUnused(registry: PluginRegistry | null): boolean {
  if (!registry || isRegistryLive(registry)) {
    return false;
  }
  markPluginRegistryRetired(registry);
  return true;
}

function syncPluginAgentEventBridge(): void {
  state.agentEventBridgeUnsubscribe?.();
  state.agentEventBridgeUnsubscribe = undefined;
  const registry = asPluginRegistry(state.activeRegistry);
  if (!registry) {
    return;
  }
  const version = state.activeVersion;
  state.agentEventBridgeUnsubscribe = onAgentEvent((event) => {
    dispatchPluginAgentEventSubscriptions({
      registry,
      event,
      // The registry object can become active again after rollback. Its version
      // keeps already-dispatched callback authority bound to this exact cutover.
      isLive: () => state.activeRegistry === registry && state.activeVersion === version,
    });
  });
}

export function recordImportedPluginId(pluginId: string): void {
  state.importedPluginIds.add(pluginId);
}

export function setActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey?: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable" = "default",
  workspaceDir?: string,
) {
  installActivePluginRegistry({
    registry,
    key: cacheKey ?? null,
    runtimeSubagentMode,
    workspaceDir: workspaceDir ?? null,
  });
}

export function stageActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string | null,
  runtimeSubagentMode: RegistryState["runtimeSubagentMode"],
  workspaceDir?: string,
): void {
  installActivePluginRegistry({
    registry,
    key: cacheKey,
    runtimeSubagentMode,
    workspaceDir: workspaceDir ?? null,
    retirePrevious: false,
  });
}

export function commitStagedPluginRegistry(
  previousRegistry: PluginRegistry | null,
  registry: PluginRegistry,
): void {
  if (state.activeRegistry !== registry || !retirePluginRegistryIfUnused(previousRegistry)) {
    return;
  }
  cleanupRetiredPluginHostRegistry(previousRegistry!);
}

export function captureActivePluginRegistrySnapshot() {
  return {
    activeRegistry: state.activeRegistry,
    key: state.key,
    runtimeSubagentMode: state.runtimeSubagentMode,
    workspaceDir: state.workspaceDir,
  };
}

export function restoreActivePluginRegistrySnapshot(
  snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>,
): void {
  installActivePluginRegistry({
    registry: snapshot.activeRegistry,
    key: snapshot.key,
    runtimeSubagentMode: snapshot.runtimeSubagentMode,
    workspaceDir: snapshot.workspaceDir,
  });
}

/** Rolls back a staged registry without reactivating the prior committed generation. */
export function rollbackStagedPluginRegistry(
  snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>,
): void {
  installActivePluginRegistry({
    registry: snapshot.activeRegistry,
    key: snapshot.key,
    runtimeSubagentMode: snapshot.runtimeSubagentMode,
    workspaceDir: snapshot.workspaceDir,
    // Staging never retired the prior registry. Reactivating it here would mint a
    // new epoch and revoke closures that remained authoritative through rollback.
    activateRegistry: false,
  });
}

function installActivePluginRegistry(params: {
  registry: PluginRegistry | null;
  key: string | null;
  runtimeSubagentMode: RegistryState["runtimeSubagentMode"];
  workspaceDir: string | null;
  retirePrevious?: boolean;
  activateRegistry?: boolean;
}): void {
  const previousRegistry = asPluginRegistry(state.activeRegistry);
  state.activeRegistry = params.registry;
  if (params.activateRegistry !== false) {
    markPluginRegistryActive(params.registry);
  }
  state.activeVersion += 1;
  if (params.registry) {
    settlePreparedMessageToolCatalog(params.registry, state.activeVersion);
  } else {
    settlePreparedMessageToolCatalog();
  }
  state.key = params.key;
  state.workspaceDir = params.workspaceDir;
  state.runtimeSubagentMode = params.runtimeSubagentMode;
  syncPluginAgentEventBridge();
  if (
    params.retirePrevious === false ||
    !previousRegistry ||
    previousRegistry === params.registry
  ) {
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

/** Reads registration/request/active registry precedence without initializing a cold runtime. */
export function getPluginRegistryForContext(): PluginRegistry | null {
  return (
    state.registrationContext?.registry ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    getActivePluginRegistry()
  );
}

export function requireActivePluginRegistry(): PluginRegistry {
  const registry = getPluginRegistryForContext();
  if (registry) {
    return registry;
  }
  state.activeRegistry = createEmptyPluginRegistry();
  markPluginRegistryActive(state.activeRegistry);
  state.activeVersion += 1;
  settlePreparedMessageToolCatalog(state.activeRegistry, state.activeVersion);
  syncPluginAgentEventBridge();
  return state.activeRegistry;
}

/** Binds unchanged direct SDK facades to the registry currently running synchronous register(). */
export function withPluginRegistrationContext<T>(
  registry: PluginRegistry,
  pluginId: string,
  run: () => T,
): T {
  const previous = state.registrationContext;
  state.registrationContext = { registry, pluginId };
  try {
    return run();
  } finally {
    state.registrationContext = previous;
  }
}

export function getPluginRegistrationContext() {
  return state.registrationContext;
}

/** Keeps direct registration facades owned by the plugin whose synchronous register() is running. */
export function resolveDirectPluginRegistrationOwner(ownerPluginId?: string): string | undefined {
  return state.registrationContext?.pluginId ?? ownerPluginId;
}

/** A failed plugin must not displace an earlier plugin's builder-local contribution. */
export function assertDirectPluginRegistrationReplacement(
  existingOwnerPluginId: string | undefined,
  capability: string,
): void {
  const pluginId = state.registrationContext?.pluginId;
  if (pluginId && existingOwnerPluginId !== pluginId) {
    throw new Error(`${capability} already registered by ${existingOwnerPluginId || "core"}`);
  }
}

export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.activeRegistry);
}

export function getActivePluginHttpRouteRegistryVersion(): number {
  return state.activeVersion;
}

export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  return requireActivePluginRegistry();
}

export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return getActivePluginChannelRegistrySnapshotFromState().registry as PluginRegistry | null;
}

export function getActivePluginChannelRegistryVersion(): number {
  return getActivePluginChannelRegistrySnapshotFromState().version;
}

export function getActivePluginGatewayCommandRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.activeRegistry);
}

export function requireActivePluginChannelRegistry(): PluginRegistry {
  const existing = getActivePluginChannelRegistry();
  if (existing) {
    return existing;
  }
  return requireActivePluginRegistry();
}

export function getActivePluginSessionExtensionRegistry(): PluginRegistry | null {
  return asPluginRegistry(state.activeRegistry);
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
  return [...imported].toSorted((left, right) => left.localeCompare(right));
}

function clearActivePluginRegistryState(): PluginRegistry | null {
  const previousRegistry = asPluginRegistry(state.activeRegistry);
  state.activeRegistry = null;
  state.activeVersion += 1;
  state.key = null;
  state.workspaceDir = null;
  state.runtimeSubagentMode = "default";
  settlePreparedMessageToolCatalog();
  syncPluginAgentEventBridge();
  if (previousRegistry) {
    markPluginRegistryRetired(previousRegistry);
  }
  return previousRegistry;
}

export async function clearActivePluginRegistry(): Promise<void> {
  const previousRegistry = clearActivePluginRegistryState();
  const clearVersion = state.activeVersion;
  const clearRegistries = (state.commandRegistryClearRegistries ??= new Map());
  if (previousRegistry) {
    clearRegistries.set(previousRegistry, (clearRegistries.get(previousRegistry) ?? 0) + 1);
  }
  const previousTail = state.commandRegistryClearTail ?? Promise.resolve();
  const completion = previousTail
    .catch(() => undefined)
    .then(async () => {
      try {
        if (previousRegistry) {
          await waitForPluginCommandExecutions(previousRegistry);
          if (registryHasPluginHostCleanupWork(previousRegistry)) {
            await cleanupPreviousPluginHostRegistry({ previousRegistry });
          }
        }
      } finally {
        // A handler-triggered clear may publish a successor before its own drain settles.
        // Never let the retired generation's tail erase that successor's host state.
        if (state.activeRegistry === null && state.activeVersion === clearVersion) {
          try {
            await drainGlobalSingletonLifecycleState("plugin-registry");
          } finally {
            clearPluginHostRuntimeState();
          }
        }
      }
    })
    .finally(() => {
      if (previousRegistry) {
        const remaining = (clearRegistries.get(previousRegistry) ?? 1) - 1;
        if (remaining === 0) {
          clearRegistries.delete(previousRegistry);
        } else {
          clearRegistries.set(previousRegistry, remaining);
        }
      }
    });
  state.commandRegistryClearTail = completion.catch((error: unknown) => {
    log.warn(`plugin registry clear failed: ${String(error)}`);
  });
  if ([...clearRegistries.keys()].some(isPluginCommandExecutionActiveHere)) {
    return;
  }
  await completion;
}

export async function prepareActivePluginRegistryShutdown(): Promise<void> {
  await loadPluginHostCleanupRuntime();
}

export function resetPluginRuntimeStateForTest(): void {
  state.registrationContext = undefined;
  clearActivePluginRegistryState();
  state.importedPluginIds.clear();
  void drainGlobalSingletonLifecycleState("plugin-registry");
  // Keep the synchronous test reset aligned with clearActivePluginRegistry.
  clearPluginHostRuntimeState();
  clearPluginMetadataLifecycleCaches();
}
