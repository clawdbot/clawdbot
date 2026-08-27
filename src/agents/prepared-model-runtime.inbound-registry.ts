import { isMainThread } from "node:worker_threads";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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
import {
  logModelCatalogPluginScope,
  resolveModelCatalogPluginScope,
} from "./prepared-model-catalog-plugin-scope.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

const workerScopeLog = createSubsystemLogger("agents/prepared-model-runtime.worker-scope");

/**
 * Scope an off-main-thread registry load to model-contributing plugins (openclaw-crb2).
 *
 * Returns `{}` on the main thread so the gateway keeps its existing behaviour exactly, and
 * `{}` again if anything about resolving the scope throws — a scope bug must not become a
 * catalog outage. Both fallbacks restore "load everything", which is slow but correct.
 */
function resolveWorkerModelCatalogBasePluginIds(
  metadataSnapshot: PluginMetadataSnapshot,
): { basePluginIds: string[] } | Record<string, never> {
  if (isMainThread) {
    return {};
  }
  try {
    const scope = resolveModelCatalogPluginScope(metadataSnapshot);
    logModelCatalogPluginScope(scope);
    return { basePluginIds: scope.pluginIds };
  } catch (error) {
    workerScopeLog.warn(
      `failed to resolve the model-catalog plugin scope; falling back to loading every plugin ` +
        `(openclaw-crb2): ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

export type PreparedInboundRegistryLoader = (
  input: PreparedModelRuntimeInput,
  metadataSnapshot: PluginMetadataSnapshot,
) => PluginRegistry;

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
    // Normalization already resolves each model to its runtime. The workspace
    // registry depends on provider/runtime ownership, not the model id itself.
    runtimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({
      provider,
      runtime,
    })),
  });
}

/** Creates one lifecycle-batch loader that shares exact generic registry identities. */
export function createPreparedInboundRegistryLoader(): PreparedInboundRegistryLoader {
  const registries = new Map<string, PluginRegistry>();
  return (input, metadataSnapshot) => {
    const key = inboundRegistryIdentity(input);
    const existing = registries.get(key);
    if (existing) {
      return existing;
    }
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
    registries.set(key, registry);
    return registry;
  };
}

/** Prepares distinct generic-inbound and model-selected registries for one workspace generation. */
export function prepareWorkspacePluginRegistries(
  input: PreparedModelRuntimeInput,
  metadataSnapshot: PluginMetadataSnapshot,
  loadInboundRegistry?: PreparedInboundRegistryLoader,
  preferBuiltPluginArtifacts = false,
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
    : loadInboundRegistry?.(input, metadataSnapshot);
  const runtimePluginRegistry =
    input.runtimePluginSelections || !inboundPluginRegistry
      ? loadAgentRuntimePluginRegistryHandle({
          ...(input.loadRuntimePlugins
            ? { basePluginIds: [] }
            : inboundPluginRegistry
              ? { basePluginIds: listRuntimePluginIdsFromRegistry(inboundPluginRegistry) }
              : // openclaw-crb2. This bare fallthrough is the defect: with no request scope
                // and no inbound registry, resolveAgentRuntimePluginRegistryLoad falls back
                // to metadataSnapshot.pluginIds — EVERY installed plugin. On the gateway's
                // main thread that is merely slow. Off the main thread it is dangerous: the
                // prepared-model-catalog worker spent 44.6s importing 55 plugins with real
                // side effects, and terminating it mid-import aborts the whole process.
                //
                // Gated on !isMainThread rather than on catalogMode deliberately — that is
                // the exact condition under which the crash occurs, and it means the
                // gateway's own main-thread behaviour is bit-for-bit unchanged.
                resolveWorkerModelCatalogBasePluginIds(metadataSnapshot)),
          config: input.config,
          env: input.env ?? process.env,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
          metadataSnapshot,
          ...(preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
          selections: input.runtimePluginSelections,
        })
      : inboundPluginRegistry;
  return {
    runtimePluginRegistry,
    ...(inboundPluginRegistry ? { inboundPluginRegistry } : {}),
  };
}
