// Loads agent tool result middleware from plugin runtime surfaces.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareRuntime,
} from "./agent-tool-result-middleware-types.js";
import { listAgentToolResultMiddlewares } from "./agent-tool-result-middleware.js";
import { loadPluginRegistryHandle } from "./loader.js";
import type { PluginAgentToolResultMiddlewareOwner, PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

const log = createSubsystemLogger("plugins/agent-tool-result-middleware");

function listMiddlewareOwners(params: {
  registry: PluginRegistry | null;
  runtime: AgentToolResultMiddlewareRuntime;
}): PluginAgentToolResultMiddlewareOwner[] {
  const owners: PluginAgentToolResultMiddlewareOwner[] = [];
  for (const owner of params.registry?.agentToolResultMiddlewareOwners ?? []) {
    if (
      owner.runtimes.includes(params.runtime) &&
      !owners.some((entry) => entry.pluginId === owner.pluginId)
    ) {
      owners.push(owner);
    }
  }
  return owners;
}

function listRuntimeMiddlewareOwnerPluginIds(
  registry: PluginRegistry | null | undefined,
  runtime: AgentToolResultMiddlewareRuntime,
): Set<string> {
  const pluginIds = new Set<string>();
  for (const entry of registry?.agentToolResultMiddlewares ?? []) {
    if (entry.runtimes.includes(runtime)) {
      pluginIds.add(entry.pluginId);
    }
  }
  return pluginIds;
}

function registryHasMiddlewareOwners(params: {
  registry: PluginRegistry | undefined;
  pluginIds: readonly string[];
  runtime: AgentToolResultMiddlewareRuntime;
}): boolean {
  if (!params.registry) {
    return false;
  }
  const ownerPluginIds = listRuntimeMiddlewareOwnerPluginIds(params.registry, params.runtime);
  return params.pluginIds.every((pluginId) => ownerPluginIds.has(pluginId));
}

export async function loadAgentToolResultMiddlewaresForRuntime(params: {
  runtime: AgentToolResultMiddlewareRuntime;
}): Promise<AgentToolResultMiddleware[]> {
  const activeHandlers = listAgentToolResultMiddlewares(params.runtime);

  try {
    const activeRegistry = getActivePluginRegistry();
    const owners = listMiddlewareOwners({
      registry: activeRegistry,
      runtime: params.runtime,
    });
    if (owners.length === 0) {
      return activeHandlers;
    }
    const activePluginIds = listRuntimeMiddlewareOwnerPluginIds(activeRegistry, params.runtime);
    const missingOwners = owners.filter((owner) => !activePluginIds.has(owner.pluginId));
    if (missingOwners.length === 0) {
      return activeHandlers;
    }
    const missingPluginIds = missingOwners.map((owner) => owner.pluginId);
    const missingPluginIdSet = new Set(missingPluginIds);

    const loadedRegistry = getLoadedRuntimePluginRegistry({
      requiredPluginIds: missingPluginIds,
    });
    const runtimeRegistry =
      loadedRegistry &&
      registryHasMiddlewareOwners({
        registry: loadedRegistry,
        pluginIds: missingPluginIds,
        runtime: params.runtime,
      })
        ? loadedRegistry
        : loadPluginRegistryHandle({
            config: (await import("../config/config.js")).getRuntimeConfig(),
            onlyPluginIds: missingPluginIds,
            manifestRegistry: {
              plugins: missingOwners.map((owner) => owner.manifest),
              diagnostics: [],
            },
            channelPluginLoadIntent: "full",
          });

    const missingHandlers = runtimeRegistry.agentToolResultMiddlewares
      .filter(
        (entry) =>
          missingPluginIdSet.has(entry.pluginId) && entry.runtimes.includes(params.runtime),
      )
      .map((entry) => entry.handler);
    return [...activeHandlers, ...missingHandlers];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`[${params.runtime}] failed to load tool result middleware plugins: ${detail}`);
    return listAgentToolResultMiddlewares(params.runtime);
  }
}
