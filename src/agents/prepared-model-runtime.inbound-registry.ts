import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

export type PreparedInboundRegistryLoader = (input: PreparedModelRuntimeInput) => PluginRegistry;

function inboundRegistryIdentity(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    workspaceDir: input.workspaceDir,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
  });
}

/** Groups model-selected workspace facts while keeping generic inbound identity narrower. */
export function preparedModelRuntimeWorkspaceFactsKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    readOnly: input.readOnly === true,
    workspaceDir: input.workspaceDir,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    runtimePluginSelections: input.runtimePluginSelections,
  });
}

/** Creates one lifecycle-batch loader that shares exact generic registry identities. */
export function createPreparedInboundRegistryLoader(): PreparedInboundRegistryLoader {
  const registries = new Map<string, PluginRegistry>();
  return (input) => {
    const key = inboundRegistryIdentity(input);
    const existing = registries.get(key);
    if (existing) {
      return existing;
    }
    const registry = loadAgentRuntimePluginRegistryHandle({
      config: input.config,
      env: input.env ?? process.env,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    });
    registries.set(key, registry);
    return registry;
  };
}

/** Prepares distinct generic-inbound and model-selected registries for one workspace generation. */
export function prepareWorkspacePluginRegistries(
  input: PreparedModelRuntimeInput,
  loadInboundRegistry?: PreparedInboundRegistryLoader,
): {
  runtimePluginRegistry?: PluginRegistry;
  inboundPluginRegistry?: PluginRegistry;
} {
  if (input.readOnly) {
    return {};
  }
  const inboundPluginRegistry = loadInboundRegistry?.(input);
  const runtimePluginRegistry =
    input.runtimePluginSelections || !inboundPluginRegistry
      ? loadAgentRuntimePluginRegistryHandle({
          config: input.config,
          env: input.env ?? process.env,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
          selections: input.runtimePluginSelections,
        })
      : inboundPluginRegistry;
  return {
    runtimePluginRegistry,
    ...(inboundPluginRegistry ? { inboundPluginRegistry } : {}),
  };
}

type PreparedInboundRegistryLifecycleHost<Owner> = Readonly<{
  isGatewayLifecycleActive: () => boolean;
  getPendingReplacement: () => Promise<void> | undefined;
  resolveConfiguredOwner: (agentId: string) => Owner | undefined;
  getPublishedSnapshot: (owner: Owner) => PreparedModelRuntimeSnapshot | undefined;
  prepareSnapshot: (owner: Owner) => Promise<PreparedModelRuntimeSnapshot>;
}>;

function requireInboundRegistry(snapshot: PreparedModelRuntimeSnapshot): PluginRegistry {
  if (!snapshot.inboundPluginRegistry) {
    throw new Error(`prepared inbound plugin registry was not published for ${snapshot.agentDir}`);
  }
  return snapshot.inboundPluginRegistry;
}

/** Binds Gateway turns to the configured owner without exposing mutable lifecycle state. */
export function createPublishedGatewayInboundPluginRegistryLoader<Owner>(
  host: PreparedInboundRegistryLifecycleHost<Owner>,
): (params: { agentId: string }) => Promise<PluginRegistry | undefined> {
  return async ({ agentId }) => {
    if (!host.isGatewayLifecycleActive()) {
      return undefined;
    }
    for (;;) {
      const replacement = host.getPendingReplacement();
      if (replacement) {
        await replacement;
        continue;
      }
      const owner = host.resolveConfiguredOwner(agentId);
      if (!owner) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared inbound plugin registry owner was not published for ${agentId}`,
        );
      }
      const published = host.getPublishedSnapshot(owner);
      return requireInboundRegistry(published ?? (await host.prepareSnapshot(owner)));
    }
  };
}
