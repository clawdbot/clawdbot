import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
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
    loadRuntimePlugins: input.loadRuntimePlugins === true,
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
  // Read-only catalog owners stay runtime-free. Executable probes opt in to provider runtime,
  // while non-core harness probes carry the exact selected plugin generation.
  if (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) {
    return {};
  }
  const inboundPluginRegistry = input.readOnly ? undefined : loadInboundRegistry?.(input);
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
