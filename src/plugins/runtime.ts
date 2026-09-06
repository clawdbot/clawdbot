import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  drainGlobalSingletonLifecycleState,
  resolveGlobalSingleton,
} from "../shared/global-singleton.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  isPluginCommandExecutionActiveHere,
  waitForPluginCommandExecutions,
} from "./command-execution-lock.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
  publishPluginSessionSchedulerJobs,
} from "./host-hook-runtime.js";
import { pluginInstanceState } from "./plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { settlePreparedMessageToolCatalog } from "./prepared-message-tool-catalog.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  adoptPluginRegistryRecords,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginChannelRegistrySnapshotFromState } from "./runtime-channel-state.js";
import { getPluginRegistryForContext } from "./runtime-context.js";
import { PLUGIN_REGISTRY_STATE, type RegistryState } from "./runtime-state.js";
export { getPluginRegistryForContext } from "./runtime-context.js";

const log = createSubsystemLogger("plugins/runtime");
const retirements = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryRetirements"),
  () => new WeakMap<PluginRegistry, () => Promise<void>>(),
);
type PluginRegistrySnapshot = ReturnType<typeof captureActivePluginRegistrySnapshot>;
const registryOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryOwners"),
  () => new Set<PluginRegistrySnapshot>(),
);

const state = resolveGlobalSingleton<RegistryState>(PLUGIN_REGISTRY_STATE, () => ({
  activeRegistry: null,
  activeVersion: 0,
  key: null,
  workspaceDir: null,
  runtimeSubagentMode: "default",
  importedPluginIds: new Set<string>(),
}));

function registryHasPluginHostCleanupWork(registry: PluginRegistry): boolean {
  return (
    registry.plugins.some((plugin) => plugin.status === "loaded" || plugin.status === "error") ||
    registry.sessionExtensions.length > 0 ||
    registry.runtimeLifecycles.length > 0 ||
    registry.agentEventSubscriptions.length > 0 ||
    registry.sessionSchedulerJobs.length > 0
  );
}

function isRegistryLive(registry: PluginRegistry): boolean {
  return (
    state.activeRegistry === registry ||
    [...registryOwners].some((owner) => owner.activeRegistry === registry)
  );
}

const loadPluginHostCleanupRuntime = createLazyRuntimeModule(
  () => import("./host-hook-cleanup.js"),
);

/** Candidate retirement releases resources without changing committed session state. */
export function disposePluginRegistryInstances(
  registry: PluginRegistry,
  retained?: PluginRegistry | (() => PluginRegistry | null),
  options?: { cleanupPersistentState?: boolean },
): Promise<void> {
  let wait = retirements.get(registry);
  if (!wait) {
    markPluginRegistryRetired(registry);
    const initialized = loadPluginHostCleanupRuntime().then(
      ({ createPluginHostRegistryRetirement }) => {
        if (retirements.get(registry) !== wait) {
          return undefined;
        }
        if (options?.cleanupPersistentState && isRegistryLive(registry)) {
          retirements.delete(registry);
          return undefined;
        }
        return createPluginHostRegistryRetirement({
          previousRegistry: registry,
          nextRegistry: typeof retained === "function" ? retained() : retained,
          skipPersistentSessionState: options?.cleanupPersistentState !== true,
          shouldCleanup: options?.cleanupPersistentState
            ? () => !isRegistryLive(registry)
            : undefined,
        });
      },
    );
    // Cache initialization, not one caller's self-retirement acknowledgment.
    wait = async () => {
      const cleanup = await (await initialized)?.();
      if (cleanup?.failures.length) {
        throw new AggregateError(
          cleanup.failures.map((failure) => failure.error),
          "Plugin host cleanup failed",
        );
      }
    };
    retirements.set(registry, wait);
    void pluginInstanceState.invocation
      .exit(wait)
      .catch((error: unknown) => log.warn(`plugin host registry cleanup failed: ${String(error)}`));
  }
  return wait();
}

function retirePluginRegistryIfUnused(
  registry: PluginRegistry | null,
  retained: () => PluginRegistry | null = () => state.activeRegistry,
): void {
  if (!registry || isRegistryLive(registry)) {
    return;
  }
  markPluginRegistryRetired(registry);
  if (registryHasPluginHostCleanupWork(registry)) {
    void disposePluginRegistryInstances(registry, retained, {
      cleanupPersistentState: true,
    }).catch(() => {});
  }
}

/** Lifecycle callers observe the same teardown that publication started. */
export async function waitForPluginRegistryRetirement(registry: PluginRegistry): Promise<void> {
  await retirements.get(registry)?.();
}

function syncPluginAgentEventBridge(): void {
  state.agentEventBridgeUnsubscribe?.();
  state.agentEventBridgeUnsubscribe = undefined;
  const registry = state.activeRegistry;
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
    activeRegistry: registry,
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
    activeRegistry: registry,
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
  if (state.activeRegistry === registry) {
    retirePluginRegistryIfUnused(previousRegistry);
  }
}

export function captureActivePluginRegistrySnapshot() {
  return {
    activeRegistry: state.activeRegistry,
    key: state.key,
    runtimeSubagentMode: state.runtimeSubagentMode,
    workspaceDir: state.workspaceDir,
  };
}

export function restoreActivePluginRegistrySnapshot(snapshot: PluginRegistrySnapshot): void {
  installActivePluginRegistry(snapshot);
}

/** Rolls back a staged registry without reactivating the prior committed generation. */
export function rollbackStagedPluginRegistry(
  snapshot: PluginRegistrySnapshot,
  retainedRegistry = snapshot.activeRegistry,
): void {
  const candidate = state.activeRegistry;
  installActivePluginRegistry({
    ...snapshot,
    // Staging never retired the prior registry. Reactivating it here would mint a
    // new epoch and revoke closures that remained authoritative through rollback.
    activateRegistry: false,
    retirePrevious: false,
  });
  // The reloading Gateway need not own the process-default projection.
  adoptPluginRegistryRecords(retainedRegistry);
  if (candidate && candidate !== snapshot.activeRegistry) {
    void disposePluginRegistryInstances(candidate, retainedRegistry ?? undefined).catch(() => {});
  }
}

function installActivePluginRegistry(
  params: PluginRegistrySnapshot & {
    retirePrevious?: boolean;
    activateRegistry?: boolean;
  },
): void {
  const previousRegistry = state.activeRegistry;
  const registry = params.activeRegistry;
  state.activeRegistry = registry;
  if (registry && previousRegistry !== registry) {
    // Retained instances can return with this registry; its old retirement selection cannot.
    retirements.delete(registry);
  }
  if (params.activateRegistry !== false) {
    markPluginRegistryActive(registry);
  } else {
    adoptPluginRegistryRecords(registry);
  }
  state.activeVersion += 1;
  if (registry) {
    publishPluginSessionSchedulerJobs(registry);
    settlePreparedMessageToolCatalog(registry, state.activeVersion);
  } else {
    settlePreparedMessageToolCatalog();
  }
  state.key = params.key;
  state.workspaceDir = params.workspaceDir;
  state.runtimeSubagentMode = params.runtimeSubagentMode;
  syncPluginAgentEventBridge();
  if (params.retirePrevious !== false) {
    retirePluginRegistryIfUnused(previousRegistry);
  }
}

/** Each Gateway owns its current registry; the process default is only a lookup projection. */
export function createPluginRegistryOwner(registry: PluginRegistry, workspaceDir?: string) {
  const owner: PluginRegistrySnapshot & { activeRegistry: PluginRegistry } = {
    key: null,
    runtimeSubagentMode: "gateway-bindable",
    workspaceDir: workspaceDir ?? null,
    ...(state.activeRegistry === registry ? captureActivePluginRegistrySnapshot() : {}),
    activeRegistry: registry,
  };
  registryOwners.add(owner);
  let closing: Promise<void> | undefined;
  return {
    get registry() {
      return owner.activeRegistry;
    },
    publish(next: PluginRegistry) {
      if (!registryOwners.has(owner) || state.activeRegistry !== next) {
        throw new Error("Plugin registry publication requires a live owner and active candidate");
      }
      const previous = owner.activeRegistry;
      Object.assign(owner, captureActivePluginRegistrySnapshot());
      retirePluginRegistryIfUnused(previous, () =>
        registryOwners.has(owner) ? owner.activeRegistry : null,
      );
    },
    close() {
      return (closing ??= (async () => {
        registryOwners.delete(owner);
        const survivor = [...registryOwners].at(-1);
        if (state.activeRegistry === owner.activeRegistry) {
          if (!survivor) {
            await clearActivePluginRegistry();
            return;
          }
          // A surviving Gateway never stopped: selecting it must not rotate its authority.
          installActivePluginRegistry({
            ...survivor,
            activateRegistry: false,
            retirePrevious: false,
          });
        }
        retirePluginRegistryIfUnused(owner.activeRegistry, () => survivor?.activeRegistry ?? null);
        await waitForPluginRegistryRetirement(owner.activeRegistry);
      })());
    },
  };
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.activeRegistry;
}

export function getActivePluginRegistryWorkspaceDir(): string | undefined {
  return state.workspaceDir ?? undefined;
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
  handlers?: Pick<NonNullable<RegistryState["registrationContext"]>, "registerMemoryCapability">,
): T {
  const previous = state.registrationContext;
  state.registrationContext = { registry, pluginId, ...handlers };
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

export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return getActivePluginChannelRegistrySnapshotFromState().registry as PluginRegistry | null;
}

export function getActivePluginChannelRegistryVersion(): number {
  return getActivePluginChannelRegistrySnapshotFromState().version;
}

export function requireActivePluginChannelRegistry(): PluginRegistry {
  return getActivePluginChannelRegistry() ?? requireActivePluginRegistry();
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

/** Includes earlier cached or failed imports; metadata-only bundles never import runtime code. */
export function listImportedRuntimePluginIds(): string[] {
  const imported = new Set(state.importedPluginIds);
  for (const plugin of state.activeRegistry?.plugins ?? []) {
    if (plugin.status === "loaded" && plugin.format !== "bundle") {
      imported.add(plugin.id);
    }
  }
  return [...imported].toSorted((left, right) => left.localeCompare(right));
}

function clearActivePluginRegistryState(): PluginRegistry | null {
  const previousRegistry = state.activeRegistry;
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
            await disposePluginRegistryInstances(previousRegistry, () => state.activeRegistry, {
              cleanupPersistentState: true,
            });
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
  registryOwners.clear();
  clearActivePluginRegistryState();
  state.importedPluginIds.clear();
  void drainGlobalSingletonLifecycleState("plugin-registry");
  // Keep the synchronous test reset aligned with clearActivePluginRegistry.
  clearPluginHostRuntimeState();
  clearPluginMetadataLifecycleCaches();
}
