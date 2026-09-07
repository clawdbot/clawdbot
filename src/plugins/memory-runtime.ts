// Runtime bridge for plugin-owned memory hooks and state.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  LegacyMemoryReadResult,
  MemoryReadResult,
  MemorySearchManager,
} from "../memory-host-sdk/host/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadPluginRegistryHandle, resolvePluginRegistryLoadCacheKey } from "./loader.js";
import {
  getMemoryRuntime,
  resolveMemoryCapabilityRegistration,
  standaloneMemoryRuntimeState,
} from "./memory-state.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import { retainPluginRegistryResources } from "./registry-resources.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

type MemoryRuntime = NonNullable<
  PluginRegistry["memoryCapabilities"][number]["capability"]["runtime"]
>;
type MemorySearchAuthorization = Parameters<
  NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>
>[0];
type WorkspaceMemoryPathClassification = Parameters<
  NonNullable<MemoryPluginRuntime["classifyWorkspaceMemoryPaths"]>
>[0];
type MemoryRuntimeOwner = { runtime: MemoryRuntime; registry?: PluginRegistry };
const registeredMemoryManagerAdapters = new WeakMap<
  RegisteredMemorySearchManager,
  MemorySearchManager
>();

function normalizeRegisteredMemoryReadResult(
  result: LegacyMemoryReadResult | MemoryReadResult,
): MemoryReadResult {
  if (result.status === "ok" || result.status === "not_found") {
    return result;
  }
  return { ...result, status: "ok" };
}

function normalizeRegisteredMemoryManager(
  manager: RegisteredMemorySearchManager,
): MemorySearchManager {
  const existing = registeredMemoryManagerAdapters.get(manager);
  if (existing) {
    return existing;
  }
  const readFile: MemorySearchManager["readFile"] = async (params) =>
    normalizeRegisteredMemoryReadResult(await manager.readFile(params));
  // A neutral target permits wrapped methods even when the manager is frozen.
  const adapter = new Proxy(
    { readFile },
    {
      get(_target, property) {
        if (property === "readFile") {
          return readFile;
        }
        const value = Reflect.get(manager, property, manager) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        // Registered managers may use class/private state, so calls retain the target receiver.
        return value.bind(manager);
      },
    },
    // SAFETY: readFile is canonical; every other member is forwarded from the manager.
  ) as MemorySearchManager;
  registeredMemoryManagerAdapters.set(manager, adapter);
  return adapter;
}

/** Resolves the configured memory slot to the single runtime plugin that may load memory. */
function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const memorySlot = plugins.slots.memory;
  if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) {
    return [];
  }
  const pluginId = memorySlot.trim();
  if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
    return [];
  }
  return [pluginId];
}

function resolveMemoryRuntimeWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const dir = resolveAgentWorkspaceDir(cfg, agentId);
  if (typeof dir !== "string" || !dir.trim()) {
    return undefined;
  }
  return resolveUserPath(dir);
}

function resolveMemoryRuntimeFromRegistry(registry: PluginRegistry) {
  return resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.capability.runtime;
}

function listCurrentMemoryRuntimeOwners(): MemoryRuntimeOwner[] {
  const current = getMemoryRuntime();
  const owners = new Map<MemoryRuntime, MemoryRuntimeOwner>();
  for (const handle of standaloneMemoryRuntimeState.slot?.retiredRuntimes ?? []) {
    const runtime = resolveMemoryRuntimeFromRegistry(handle.registry);
    if (runtime) {
      owners.set(runtime, { runtime, registry: handle.registry });
    }
  }
  if (current) {
    owners.set(current, { runtime: current });
  }
  if (standaloneMemoryRuntimeState.slot) {
    const runtime = resolveMemoryRuntimeFromRegistry(
      standaloneMemoryRuntimeState.slot.handle.registry,
    );
    if (runtime) {
      owners.set(runtime, { runtime, registry: standaloneMemoryRuntimeState.slot.handle.registry });
    }
  }
  return [...owners.values()];
}

function withMemoryRuntimeOwner<T>(
  owner: MemoryRuntimeOwner,
  run: (runtime: MemoryRuntime) => T,
): T {
  const claim = owner.registry ? retainPluginRegistryResources(owner.registry) : undefined;
  try {
    return withPluginRuntimeRegistryScope(owner.registry, () => run(owner.runtime));
  } finally {
    claim?.release();
  }
}

async function withMemoryRuntimeOwnerAsync<T>(
  owner: MemoryRuntimeOwner,
  run: (runtime: MemoryRuntime) => Promise<T>,
): Promise<T> {
  const claim = owner.registry ? retainPluginRegistryResources(owner.registry) : undefined;
  try {
    return await withPluginRuntimeRegistryScope(owner.registry, () => run(owner.runtime));
  } finally {
    claim?.release();
  }
}

function ensureMemoryRuntime(params?: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeOwner | undefined {
  const current = getMemoryRuntime();
  if (current || !params) {
    return current ? { runtime: current } : undefined;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(params.cfg);
  if (onlyPluginIds.length === 0) {
    return undefined;
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(params.cfg, params.agentId);
  const loadOptions = {
    config: params.cfg,
    onlyPluginIds,
    workspaceDir,
    activate: false as const,
  };
  const key = resolvePluginRegistryLoadCacheKey(loadOptions);
  if (standaloneMemoryRuntimeState.slot?.key === key) {
    const runtime = resolveMemoryRuntimeFromRegistry(
      standaloneMemoryRuntimeState.slot.handle.registry,
    );
    return runtime
      ? { runtime, registry: standaloneMemoryRuntimeState.slot.handle.registry }
      : undefined;
  }
  const handle = loadPluginRegistryHandle(loadOptions);
  const { registry } = handle;
  const runtime = resolveMemoryRuntimeFromRegistry(registry);
  const previousSlot = standaloneMemoryRuntimeState.slot;
  const retiredRuntimes = new Set(previousSlot?.retiredRuntimes);
  if (previousSlot) {
    retiredRuntimes.add(previousSlot.handle);
  }
  standaloneMemoryRuntimeState.slot = { key, handle, retiredRuntimes };
  standaloneMemoryRuntimeState.generation += 1;
  return runtime ? { runtime, registry } : undefined;
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  inspectSources?: boolean;
}) {
  const owner = ensureMemoryRuntime(params);
  if (!owner) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  if (owner.registry) {
    standaloneMemoryRuntimeState.active = true;
    standaloneMemoryRuntimeState.generation += 1;
  }
  const result = await withMemoryRuntimeOwnerAsync(
    owner,
    async (runtime) => await runtime.getMemorySearchManager(params),
  );
  return {
    ...result,
    manager: result.manager ? normalizeRegisteredMemoryManager(result.manager) : null,
  };
}

/** Applies the selected memory plugin's authorization policy to raw search hits. */
export async function authorizeActiveMemorySearchHits(
  params: MemorySearchAuthorization,
): Promise<MemorySearchAuthorization["hits"]> {
  const owner = ensureMemoryRuntime(params);
  if (!owner) {
    // Session artifacts need plugin-owned identity mapping before they are safe
    // to expose. Runtimes without that capability may still return memory hits.
    return params.hits.filter((hit) => hit.source !== "sessions");
  }
  return await withMemoryRuntimeOwnerAsync(owner, async (runtime) => {
    if (!runtime.authorizeSearchHits) {
      return params.hits.filter((hit) => hit.source !== "sessions");
    }
    return await runtime.authorizeSearchHits(params);
  });
}

/** Classifies workspace memory paths through the selected memory plugin's provenance owner. */
export async function classifyActiveMemoryWorkspacePaths(
  params: WorkspaceMemoryPathClassification,
): Promise<
  | { status: "unavailable" }
  | { status: "unsupported" }
  | {
      status: "classified";
      classifications: Array<{ relativePath: string; originClass: string }>;
    }
> {
  const owner = ensureMemoryRuntime(params);
  if (!owner) {
    return { status: "unavailable" };
  }
  if (!owner.runtime.classifyWorkspaceMemoryPaths) {
    return { status: "unsupported" };
  }
  const classifications = await withMemoryRuntimeOwnerAsync(
    owner,
    async (runtime) => await runtime.classifyWorkspaceMemoryPaths!(params),
  );
  return { status: "classified", classifications };
}

/** Resolves current memory backend config without constructing a manager. */
export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  const owner = ensureMemoryRuntime(params);
  return owner
    ? withMemoryRuntimeOwner(owner, (runtime) => runtime.resolveMemoryBackendConfig(params))
    : null;
}

/** Closes all active plugin-backed memory search managers. */
export async function closeActiveMemorySearchManagersCore(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const generation = standaloneMemoryRuntimeState.generation;
  const retired = [...(standaloneMemoryRuntimeState.slot?.retiredRuntimes ?? [])];
  await Promise.all(
    listCurrentMemoryRuntimeOwners().map((owner) =>
      withMemoryRuntimeOwnerAsync(owner, async (runtime) => {
        await runtime.closeAllMemorySearchManagers?.();
      }),
    ),
  );
  // A new manager admitted during close owns the retained handles until its own cleanup.
  if (generation !== standaloneMemoryRuntimeState.generation) {
    return;
  }
  for (const handle of retired) {
    standaloneMemoryRuntimeState.slot?.retiredRuntimes.delete(handle);
    handle.release();
  }
  standaloneMemoryRuntimeState.active = false;
}

/** Closes the plugin-backed memory search manager for one agent. */
export async function closeActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  await Promise.all(
    listCurrentMemoryRuntimeOwners().map((owner) =>
      withMemoryRuntimeOwnerAsync(owner, async (runtime) => {
        await runtime.closeMemorySearchManager?.(params);
      }),
    ),
  );
}

function resetStandaloneMemoryRegistrySlot(): void {
  const slot = standaloneMemoryRuntimeState.slot;
  standaloneMemoryRuntimeState.slot = undefined;
  slot?.handle.release();
  for (const handle of slot?.retiredRuntimes ?? []) {
    handle.release();
  }
  standaloneMemoryRuntimeState.active = false;
}

resolveGlobalSingleton(
  Symbol.for("openclaw.standaloneMemoryRegistryHost"),
  () => standaloneMemoryRuntimeState,
  async (state) => {
    const generation = state.generation;
    await closeActiveMemorySearchManagersCore();
    if (generation === state.generation) {
      resetStandaloneMemoryRegistrySlot();
    }
  },
);

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.memoryRuntimeTestApi")] = {
    resetStandaloneMemoryRegistrySlot,
  };
}
