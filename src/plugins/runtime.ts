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

export type ActivePluginRegistrySnapshot = {
  activeRegistry: PluginRegistry | null;
  key: string | null;
  runtimeSubagentMode: RegistryState["runtimeSubagentMode"];
  workspaceDir: string | null;
  // The staged-abort revert armed for the captured registry when the capture happened
  // mid-attempt (registry staged, not yet committed). Restore re-arms it so the displaced
  // survivor stays recoverable across a capture/restore round-trip — the loader's activation
  // failure rollback would otherwise strand the survivor behind a plain-clear marker wipe.
  stagedRevert: ActivePluginRegistrySnapshot | null;
};

// Arms exactly one revert for the currently staged registry: staging displaces a still-live
// registry WITHOUT retiring it, so if the staged attempt is cleared before commit the displaced
// snapshot (registry, key, subagent mode, workspace dir) must come back — otherwise the clear
// empties the slot and its tail wipes global host state the displaced survivor still owns.
// Staging a successor over a still-staged attempt TRANSFERS the marker (the abort target stays
// the original survivor); committing a transferred marker RETAINS it (the survivor's retirement
// defers to finalizeStagedPluginRegistryReplacement on complete startup success); any other
// install or clear invalidates it so a stale snapshot can never resurrect.
let stagedRegistryRevert: {
  registry: PluginRegistry;
  snapshot: ActivePluginRegistrySnapshot;
} | null = null;

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
  if (!state.activeRegistry) {
    return;
  }
  state.agentEventBridgeUnsubscribe = onAgentEvent((event) => {
    const registry = asPluginRegistry(state.activeRegistry);
    if (registry) {
      dispatchPluginAgentEventSubscriptions({ registry, event });
    }
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
  const displaced = captureActivePluginRegistrySnapshot();
  installActivePluginRegistry({
    registry,
    key: cacheKey,
    runtimeSubagentMode,
    workspaceDir: workspaceDir ?? null,
    retirePrevious: false,
  });
  // Staging over a still-staged uncommitted attempt (the loader activating the fully loaded
  // startup registry over the gateway's pre-bind provisional one) TRANSFERS the marker: the
  // abort target stays the ORIGINAL displaced survivor, never the intermediate attempt
  // registry — the commit retires that intermediate instead of the clear restoring it.
  const revertSnapshot = displaced.stagedRevert ?? displaced;
  // A no-survivor stage keeps plain clear semantics (empty slot + host-state wipe); only a
  // displaced live registry earns the abort-by-clear revert.
  stagedRegistryRevert =
    revertSnapshot.activeRegistry && revertSnapshot.activeRegistry !== registry
      ? { registry, snapshot: revertSnapshot }
      : null;
}

export function commitStagedPluginRegistry(
  previousRegistry: PluginRegistry | null,
  registry: PluginRegistry,
): void {
  // A transferred marker (nested stage) means the true displaced survivor lives in the marker
  // snapshot; the caller's previousRegistry is then the intermediate attempt registry it
  // captured before its own stage. Only the intermediate retires here: the survivor is still
  // live and serving until the whole startup succeeds, so its destructive retirement DEFERS —
  // the marker persists as the abortable handle until finalize consumes it, or a clear aborts
  // back to the survivor. A direct marker (the caller's own stage, previousRegistry IS the
  // survivor) has no deferred window and completes the replacement immediately.
  const marker = stagedRegistryRevert?.registry === registry ? stagedRegistryRevert : null;
  const displacedSurvivor = marker ? marker.snapshot.activeRegistry : previousRegistry;
  const deferSurvivorRetirement =
    marker !== null && displacedSurvivor !== previousRegistry && state.activeRegistry === registry;
  if (marker && !deferSurvivorRetirement) {
    // The attempt owns the slot from here: a later clear is a real clear, not an abort.
    stagedRegistryRevert = null;
  }
  if (state.activeRegistry !== registry) {
    return;
  }
  if (previousRegistry !== displacedSurvivor && retirePluginRegistryIfUnused(previousRegistry)) {
    cleanupRetiredPluginHostRegistry(previousRegistry!);
  }
  if (deferSurvivorRetirement || !retirePluginRegistryIfUnused(displacedSurvivor)) {
    return;
  }
  cleanupRetiredPluginHostRegistry(displacedSurvivor!);
}

/**
 * Consumes a retained (transferred) marker on complete startup success: the displaced survivor
 * retires exactly once here, as a completed replacement. Until this runs, the marker keeps the
 * survivor abortable — clearActivePluginRegistry after a failed late startup restores it.
 * No-op when no deferred window is open (fresh start, reload replacement, minimal gateway).
 */
export function finalizeStagedPluginRegistryReplacement(): void {
  if (!stagedRegistryRevert || stagedRegistryRevert.registry !== state.activeRegistry) {
    return;
  }
  const displacedSurvivor = stagedRegistryRevert.snapshot.activeRegistry;
  stagedRegistryRevert = null;
  if (!retirePluginRegistryIfUnused(displacedSurvivor)) {
    return;
  }
  cleanupRetiredPluginHostRegistry(displacedSurvivor!);
}

export function captureActivePluginRegistrySnapshot(): ActivePluginRegistrySnapshot {
  return {
    activeRegistry: state.activeRegistry,
    key: state.key,
    runtimeSubagentMode: state.runtimeSubagentMode,
    workspaceDir: state.workspaceDir,
    stagedRevert:
      stagedRegistryRevert && stagedRegistryRevert.registry === state.activeRegistry
        ? stagedRegistryRevert.snapshot
        : null,
  };
}

export function restoreActivePluginRegistrySnapshot(snapshot: ActivePluginRegistrySnapshot): void {
  installActivePluginRegistry({
    registry: snapshot.activeRegistry,
    key: snapshot.key,
    runtimeSubagentMode: snapshot.runtimeSubagentMode,
    workspaceDir: snapshot.workspaceDir,
  });
  // Restoring a still-staged uncommitted attempt re-arms its abort so a later clear reverts
  // to the original displaced survivor instead of wiping the slot.
  if (snapshot.stagedRevert && snapshot.activeRegistry) {
    stagedRegistryRevert = { registry: snapshot.activeRegistry, snapshot: snapshot.stagedRevert };
  }
}

function installActivePluginRegistry(params: {
  registry: PluginRegistry | null;
  key: string | null;
  runtimeSubagentMode: RegistryState["runtimeSubagentMode"];
  workspaceDir: string | null;
  retirePrevious?: boolean;
}): void {
  // Any install supersedes a pending staged revert (staging re-arms it after this returns).
  stagedRegistryRevert = null;
  const previousRegistry = asPluginRegistry(state.activeRegistry);
  state.activeRegistry = params.registry;
  markPluginRegistryActive(params.registry);
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

export function requireActivePluginRegistry(): PluginRegistry {
  if (state.registrationContext) {
    return state.registrationContext.registry;
  }
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  if (scopedRegistry) {
    return scopedRegistry;
  }
  if (!state.activeRegistry) {
    state.activeRegistry = createEmptyPluginRegistry();
    markPluginRegistryActive(state.activeRegistry);
    state.activeVersion += 1;
    settlePreparedMessageToolCatalog(state.activeRegistry, state.activeVersion);
    syncPluginAgentEventBridge();
  }
  return asPluginRegistry(state.activeRegistry)!;
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

export function getActivePluginGatewayNodePolicyRegistry(): PluginRegistry | null {
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
  stagedRegistryRevert = null;
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
  // Clearing an unfinalized attempt (staged, or committed with a retained marker awaiting
  // finalize) is an ABORT: capture the displaced survivor snapshot before the state clear
  // consumes the marker, restore it synchronously below. The attempt's own registry — by the
  // committed phase the fully LOADED one with live hooks — tears down through the clear's
  // normal retirement path first; the survivor's slot restore follows.
  const revertSnapshot =
    stagedRegistryRevert && stagedRegistryRevert.registry === state.activeRegistry
      ? stagedRegistryRevert.snapshot
      : null;
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
  if (revertSnapshot) {
    // Restore the survivor synchronously after starting the clear: the version bump makes the
    // clear's tail skip its global host-state wipe (run contexts, dynamic scheduler jobs the
    // survivor still owns) while the retired attempt registry's own cleanup still completes.
    restoreActivePluginRegistrySnapshot(revertSnapshot);
  }
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
