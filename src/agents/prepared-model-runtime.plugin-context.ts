import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  resolvePluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { createAgentRuntimeMetadataPluginIdScope } from "./harness/runtime-plugin-load-plan.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const emptyPluginDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

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
    setPluginRuntimeLoadContext(registry, context);
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
  // Slot probing preserves the published Gateway generation identity; cold callers
  // still fall through to a fresh metadata load.
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
