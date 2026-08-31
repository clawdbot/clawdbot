import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import {
  listRuntimePluginIdsFromRegistry,
  registryMatchesManifestPluginIds,
} from "../plugins/active-runtime-registry.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
  getActivePluginRuntimeSubagentMode,
} from "../plugins/runtime.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

type PreparedInboundRegistryInput = Pick<
  PreparedModelRuntimeInput,
  "config" | "env" | "workspaceDir" | "allowGatewaySubagentBinding"
>;

export type PreparedInboundRegistryLoader = (
  input: PreparedInboundRegistryInput,
  metadataSnapshot: PluginMetadataSnapshot,
) => PluginRegistry;

function inboundRegistryIdentity(input: PreparedInboundRegistryInput): string {
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
    // Normalization already resolves each model to its runtime. The workspace
    // registry depends on provider/runtime ownership, not the model id itself.
    runtimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({
      provider,
      runtime,
    })),
  });
}

/** Loads generic plugin facts without acquiring model, catalog, or credential state. */
export function loadPreparedInboundPluginRegistry(
  input: PreparedInboundRegistryInput,
  metadataSnapshot = prepareOwnedPluginLoadContext(input, input.env ?? process.env, undefined),
): PluginRegistry {
  const activeRegistry = getActivePluginRegistry();
  // Identity is the generation authority. Manifest equivalence alone could let a
  // stale active registry satisfy a newer bundled snapshot.
  const reusableGatewayRegistry =
    input.allowGatewaySubagentBinding === true &&
    input.env === undefined &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable" &&
    activeRegistry &&
    getActivePluginRegistryWorkspaceDir() === metadataSnapshot.workspaceDir &&
    getCurrentPluginMetadataSnapshot({
      config: input.config,
      workspaceDir: metadataSnapshot.workspaceDir,
      allowWorkspaceScopedSnapshot: true,
    }) === metadataSnapshot &&
    registryMatchesManifestPluginIds(
      activeRegistry,
      metadataSnapshot.manifestRegistry.plugins,
      listRuntimePluginIdsFromRegistry(activeRegistry),
    )
      ? activeRegistry
      : undefined;
  const registry =
    reusableGatewayRegistry ??
    loadAgentRuntimePluginRegistryHandle({
      config: input.config,
      env: input.env ?? process.env,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
      metadataSnapshot,
      preferBuiltPluginArtifacts: true,
    });
  prepareOwnedPluginLoadContext(input, input.env ?? process.env, registry, metadataSnapshot, true);
  return registry;
}

/** Creates one lifecycle-batch loader that shares exact generic registry identities. */
export function createPreparedInboundRegistryLoader(): PreparedInboundRegistryLoader {
  const registries = new Map<
    string,
    { metadataSnapshot: PluginMetadataSnapshot; registry: PluginRegistry }
  >();
  return (input, metadataSnapshot) => {
    const key = inboundRegistryIdentity(input);
    const existing = registries.get(key);
    if (existing?.metadataSnapshot === metadataSnapshot) {
      return existing.registry;
    }
    const registry = loadPreparedInboundPluginRegistry(input, metadataSnapshot);
    registries.set(key, { metadataSnapshot, registry });
    return registry;
  };
}

/** Prepares distinct generic-inbound and model-selected registries for one workspace generation. */
export function prepareWorkspacePluginRegistries(
  input: PreparedModelRuntimeInput,
  metadataSnapshot: PluginMetadataSnapshot,
  loadInboundRegistry?: PreparedInboundRegistryLoader,
  preferBuiltPluginArtifacts = false,
  reusableGeneration?: PreparedModelRuntimePluginGeneration,
): {
  runtimePluginRegistry?: PluginRegistry;
  inboundPluginRegistry?: PluginRegistry;
} {
  // Read-only catalog owners stay runtime-free. Executable probes opt in to provider runtime,
  // while non-core harness probes carry the exact selected plugin generation.
  if (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) {
    return {};
  }
  const inboundPluginRegistry = input.readOnly
    ? undefined
    : (reusableGeneration?.inboundPluginRegistry ?? loadInboundRegistry?.(input, metadataSnapshot));
  const baseRegistry = reusableGeneration?.pluginRegistry ?? inboundPluginRegistry;
  const runtimePluginRegistry =
    input.runtimePluginSelections || !baseRegistry
      ? loadAgentRuntimePluginRegistryHandle({
          ...(input.loadRuntimePlugins
            ? { basePluginIds: [] }
            : baseRegistry
              ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) }
              : {}),
          ...(reusableGeneration?.pluginRegistry
            ? { reusableRegistry: reusableGeneration.pluginRegistry }
            : {}),
          config: input.config,
          env: input.env ?? process.env,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
          metadataSnapshot,
          ...(preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
          selections: input.runtimePluginSelections,
        })
      : baseRegistry;
  return {
    runtimePluginRegistry,
    ...(inboundPluginRegistry ? { inboundPluginRegistry } : {}),
  };
}
