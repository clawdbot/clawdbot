// Runtime bridge for plugin-owned memory hooks and state.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadPluginRegistryHandle, resolvePluginRegistryLoadCacheKey } from "./loader.js";
import {
  getMemoryRuntime,
  resolveMemoryCapabilityRegistration,
  setStandaloneMemoryManagerActive,
} from "./memory-state.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

type MemoryRuntime = NonNullable<
  PluginRegistry["memoryCapabilities"][number]["capability"]["runtime"]
>;
type MemorySearchAuthorization = Parameters<
  NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>
>[0];
type MemoryRuntimeOwner = { runtime: MemoryRuntime; registry?: PluginRegistry };
let standaloneMemoryRegistrySlot:
  | { key: string; registry: PluginRegistry; retiredRuntimes: Map<MemoryRuntime, PluginRegistry> }
  | undefined;

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
  for (const [runtime, registry] of standaloneMemoryRegistrySlot?.retiredRuntimes ?? []) {
    owners.set(runtime, { runtime, registry });
  }
  if (current) {
    owners.set(current, { runtime: current });
  }
  if (standaloneMemoryRegistrySlot) {
    const runtime = resolveMemoryRuntimeFromRegistry(standaloneMemoryRegistrySlot.registry);
    if (runtime) {
      owners.set(runtime, { runtime, registry: standaloneMemoryRegistrySlot.registry });
    }
  }
  return [...owners.values()];
}

function withMemoryRuntimeOwner<T>(
  owner: MemoryRuntimeOwner,
  run: (runtime: MemoryRuntime) => T,
): T {
  return withPluginRuntimeRegistryScope(owner.registry, () => run(owner.runtime));
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
  if (standaloneMemoryRegistrySlot?.key === key) {
    const runtime = resolveMemoryRuntimeFromRegistry(standaloneMemoryRegistrySlot.registry);
    return runtime ? { runtime, registry: standaloneMemoryRegistrySlot.registry } : undefined;
  }
  const registry = loadPluginRegistryHandle(loadOptions);
  if (!registry) {
    return undefined;
  }
  const runtime = resolveMemoryRuntimeFromRegistry(registry);
  const previousSlot = standaloneMemoryRegistrySlot;
  const retiredRuntimes = new Map(previousSlot?.retiredRuntimes);
  const previousRuntime = previousSlot
    ? resolveMemoryRuntimeFromRegistry(previousSlot.registry)
    : undefined;
  if (previousSlot && previousRuntime && previousRuntime !== runtime) {
    retiredRuntimes.set(previousRuntime, previousSlot.registry);
  }
  standaloneMemoryRegistrySlot = { key, registry, retiredRuntimes };
  return runtime ? { runtime, registry } : undefined;
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
}) {
  const owner = ensureMemoryRuntime(params);
  if (!owner) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  if (owner.registry) {
    setStandaloneMemoryManagerActive(true);
  }
  return await withMemoryRuntimeOwner(
    owner,
    async (runtime) => await runtime.getMemorySearchManager(params),
  );
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
  return await withMemoryRuntimeOwner(owner, async (runtime) => {
    if (!runtime.authorizeSearchHits) {
      return params.hits.filter((hit) => hit.source !== "sessions");
    }
    return await runtime.authorizeSearchHits(params);
  });
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
  await Promise.all(
    listCurrentMemoryRuntimeOwners().map((owner) =>
      withMemoryRuntimeOwner(owner, async (runtime) => {
        await runtime.closeAllMemorySearchManagers?.();
      }),
    ),
  );
  standaloneMemoryRegistrySlot?.retiredRuntimes.clear();
  setStandaloneMemoryManagerActive(false);
}

/** Closes the plugin-backed memory search manager for one agent. */
export async function closeActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  await Promise.all(
    listCurrentMemoryRuntimeOwners().map((owner) =>
      withMemoryRuntimeOwner(owner, async (runtime) => {
        await runtime.closeMemorySearchManager?.(params);
      }),
    ),
  );
}

function resetStandaloneMemoryRegistrySlot(): void {
  standaloneMemoryRegistrySlot = undefined;
  setStandaloneMemoryManagerActive(false);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.memoryRuntimeTestApi")] = {
    resetStandaloneMemoryRegistrySlot,
  };
}
