import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { createAgentRuntimeMetadataPluginIdScope } from "./harness/runtime-plugin-load-plan.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

type PreparedPluginContextInput = Pick<
  PreparedModelRuntimeInput,
  "config" | "workspaceDir" | "loadRuntimePlugins" | "runtimePluginSelections"
>;

const emptyPluginDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

/** Resolves and attaches the plugin facts owned by one prepared workspace generation. */
export function prepareOwnedPluginLoadContext(
  input: PreparedPluginContextInput,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry | undefined,
  preparedMetadataSnapshot?: PluginMetadataSnapshot,
  preferBuiltPluginArtifacts = false,
): PluginMetadataSnapshot {
  const metadataSnapshot =
    preparedMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
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
  if (!registry) {
    return metadataSnapshot;
  }
  const { config } = input;
  const workspaceDir = metadataSnapshot.workspaceDir ?? input.workspaceDir;
  // The prepared owner already selected the exact metadata generation for this runtime.
  // Missing discovery facts stay empty here instead of reopening cold plugin discovery.
  const discoverySnapshot = metadataSnapshot.discovery
    ? metadataSnapshot
    : { ...metadataSnapshot, discovery: emptyPluginDiscovery };
  const context = {
    ...resolvePluginRuntimeLoadContext({
      config,
      env,
      workspaceDir,
      metadataSnapshot: discoverySnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      preferBuiltPluginArtifacts,
    }),
    metadataSnapshot,
  };
  // The prepared registry is the lifecycle-owned carrier; standalone callers keep the cold path.
  setPluginRuntimeLoadContext(registry, context);
  return metadataSnapshot;
}
