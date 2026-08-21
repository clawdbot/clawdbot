import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { createAgentRuntimeMetadataPluginIdScope } from "./harness/runtime-plugin-load-plan.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const preparedPluginRuntimeLoadContext = Symbol("preparedPluginRuntimeLoadContext");
const emptyPluginDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

type PreparedPluginRegistry = PluginRegistry & {
  [preparedPluginRuntimeLoadContext]?: PluginRuntimeLoadContext;
};

function setPreparedPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
): void {
  (registry as PreparedPluginRegistry)[preparedPluginRuntimeLoadContext] = context;
}

function preparePluginLoadContext(
  input: PreparedModelRuntimeInput,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry | undefined,
  metadataSnapshot: PluginMetadataSnapshot,
  preferBuiltPluginArtifacts: boolean,
): PluginRuntimeLoadContext & { metadataSnapshot: PluginMetadataSnapshot } {
  const { config } = input;
  const workspaceDir = metadataSnapshot.workspaceDir ?? input.workspaceDir;
  // The prepared owner already selected the exact metadata generation for this runtime.
  // Missing discovery facts stay empty here instead of reopening cold plugin discovery.
  const preparedMetadataSnapshot = metadataSnapshot.discovery
    ? metadataSnapshot
    : { ...metadataSnapshot, discovery: emptyPluginDiscovery };
  const context = {
    ...resolvePluginRuntimeLoadContext({
      config,
      env,
      workspaceDir,
      metadataSnapshot: preparedMetadataSnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      preferBuiltPluginArtifacts,
    }),
    metadataSnapshot,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index),
  };
  if (registry) {
    // The prepared registry is the lifecycle-owned carrier; standalone callers keep the cold path.
    setPreparedPluginRuntimeLoadContext(registry, context);
  }
  return context;
}

/** Resolves and attaches the plugin facts owned by one prepared workspace generation. */
export function prepareOwnedPluginLoadContext(
  input: PreparedModelRuntimeInput,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry | undefined,
  preparedMetadataSnapshot?: PluginMetadataSnapshot,
  preferBuiltPluginArtifacts = false,
): PluginMetadataSnapshot {
  const metadataSnapshot = preparedMetadataSnapshot ?? resolveColdMetadataSnapshot(input, env);
  preparePluginLoadContext(input, env, registry, metadataSnapshot, preferBuiltPluginArtifacts);
  return metadataSnapshot;
}

function resolveColdMetadataSnapshot(
  input: PreparedModelRuntimeInput,
  env: NodeJS.ProcessEnv,
): PluginMetadataSnapshot {
  // Resolve (slot-probing) instead of load: in the gateway the published current
  // generation satisfies this read, which keeps snapshot identity stable for the
  // generation-bound registry reuse in the inbound loader.
  const resolvedMetadataSnapshot = resolvePluginMetadataSnapshot({
    config: input.config,
    env,
    ...(input.workspaceDir
      ? { workspaceDir: input.workspaceDir, allowWorkspaceScopedCurrent: true }
      : {}),
    ...(input.loadRuntimePlugins && input.runtimePluginSelections && input.workspaceDir
      ? {
          pluginIdScope: createAgentRuntimeMetadataPluginIdScope({
            config: input.config,
            workspaceDir: input.workspaceDir,
            selections: input.runtimePluginSelections,
          }),
        }
      : {}),
  });
  return resolvedMetadataSnapshot;
}

/** Reads plugin facts carried by a lifecycle-owned prepared runtime snapshot. */
export const getPreparedPluginRuntimeLoadContext = (
  registry: PluginRegistry | undefined,
): PluginRuntimeLoadContext | undefined =>
  (registry as PreparedPluginRegistry | undefined)?.[preparedPluginRuntimeLoadContext];
