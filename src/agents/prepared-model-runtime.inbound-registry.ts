import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import {
  listRuntimePluginIdsFromRegistry,
  registryMatchesManifestPluginIds,
} from "../plugins/active-runtime-registry.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  requirePluginRegistryResourceScope,
  retainPluginRegistryResources,
  type PluginRegistryHandle,
} from "../plugins/registry-resources.js";
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
  configuredHarnessRuntimes?: readonly string[],
) => PluginRegistryHandle;

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
  configuredHarnessRuntimes?: readonly string[],
): PluginRegistryHandle {
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
  const handle = reusableGatewayRegistry
    ? {
        registry: reusableGatewayRegistry,
        ...retainPluginRegistryResources(reusableGatewayRegistry),
      }
    : loadAgentRuntimePluginRegistryHandle({
        config: input.config,
        env: input.env ?? process.env,
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
        metadataSnapshot,
        preferBuiltPluginArtifacts: true,
        configuredHarnessRuntimes,
      });
  try {
    prepareOwnedPluginLoadContext(
      input,
      input.env ?? process.env,
      handle.registry,
      metadataSnapshot,
      true,
    );
    return handle;
  } catch (error) {
    handle.release();
    throw error;
  }
}

/** Creates one lifecycle-batch loader that shares exact generic registry identities. */
export function createPreparedInboundRegistryLoader(): PreparedInboundRegistryLoader & {
  release(): void;
} {
  const registries = new Map<
    string,
    { metadataSnapshot: PluginMetadataSnapshot; handle: PluginRegistryHandle }
  >();
  const load: PreparedInboundRegistryLoader = (
    input,
    metadataSnapshot,
    configuredHarnessRuntimes,
  ) => {
    const key = inboundRegistryIdentity(input);
    const existing = registries.get(key);
    if (existing?.metadataSnapshot === metadataSnapshot) {
      return {
        registry: existing.handle.registry,
        ...retainPluginRegistryResources(existing.handle.registry),
      };
    }
    const handle = loadPreparedInboundPluginRegistry(
      input,
      metadataSnapshot,
      configuredHarnessRuntimes,
    );
    registries.set(key, { metadataSnapshot, handle });
    existing?.handle.release();
    return { registry: handle.registry, ...retainPluginRegistryResources(handle.registry) };
  };
  return Object.assign(load, {
    release() {
      for (const { handle } of registries.values()) {
        handle.release();
      }
      registries.clear();
    },
  });
}

/** Prepares distinct generic-inbound and model-selected registries for one workspace generation. */
export function prepareWorkspacePluginRegistries(
  input: PreparedModelRuntimeInput,
  metadataSnapshot: PluginMetadataSnapshot,
  loadInboundRegistry?: PreparedInboundRegistryLoader,
  preferBuiltPluginArtifacts = false,
  reusableGeneration?: PreparedModelRuntimePluginGeneration,
  getConfiguredHarnessRuntimes?: () => readonly string[],
  basePluginIds?: readonly string[],
): {
  runtimePluginRegistry?: PluginRegistry;
  inboundPluginRegistry?: PluginRegistry;
} {
  // Read-only catalog owners stay runtime-free. Executable probes opt in to provider runtime,
  // while non-core harness probes carry the exact selected plugin generation.
  if (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) {
    return {};
  }
  const resources = requirePluginRegistryResourceScope();
  const retain = (registry: PluginRegistry | undefined) => {
    if (registry) {
      resources.retain(registry);
    }
    return registry;
  };
  // Resolve batch facts only for a registry load; read-only and reused registries need no scan.
  const inboundHandle =
    !input.readOnly && !reusableGeneration?.inboundPluginRegistry
      ? loadInboundRegistry?.(input, metadataSnapshot, getConfiguredHarnessRuntimes?.())
      : undefined;
  const inboundPluginRegistry = input.readOnly
    ? undefined
    : (retain(reusableGeneration?.inboundPluginRegistry) ??
      (inboundHandle ? resources.adopt(inboundHandle) : undefined));
  const baseRegistry = retain(reusableGeneration?.pluginRegistry) ?? inboundPluginRegistry;
  const runtimePluginRegistry =
    input.runtimePluginSelections || !baseRegistry
      ? resources.adopt(
          loadAgentRuntimePluginRegistryHandle({
            ...(input.loadRuntimePlugins
              ? { basePluginIds: [] }
              : baseRegistry
                ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) }
                : basePluginIds !== undefined
                  ? { basePluginIds }
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
            configuredHarnessRuntimes: getConfiguredHarnessRuntimes?.(),
          }),
        )
      : baseRegistry;
  return {
    runtimePluginRegistry,
    ...(inboundPluginRegistry ? { inboundPluginRegistry } : {}),
  };
}
