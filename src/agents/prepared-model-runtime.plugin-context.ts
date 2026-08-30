import {
  getCurrentPluginMetadataSnapshot,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
} from "../plugins/current-plugin-metadata-snapshot.js";
import {
  getCurrentPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  preparePluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
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

/** Resolves and attaches the plugin facts owned by one prepared workspace generation. */
export function prepareOwnedPluginLoadContext(
  input: PreparedPluginContextInput,
  env: NodeJS.ProcessEnv,
  registry?: PluginRegistry,
  preparedMetadataSnapshot?: PluginMetadataSnapshot,
  preferBuiltPluginArtifacts = false,
): PluginMetadataSnapshot {
  const metadataSnapshot = preparedMetadataSnapshot ?? prepareOperationMetadataSnapshot(input, env);
  if (registry) {
    setPluginRuntimeLoadContext(
      registry,
      resolvePluginRuntimeLoadContext({
        config: input.config,
        env,
        workspaceDir: metadataSnapshot.workspaceDir ?? input.workspaceDir,
        metadataSnapshot,
        preferBuiltPluginArtifacts,
      }),
    );
  }
  return metadataSnapshot;
}

function prepareOperationMetadataSnapshot(
  input: PreparedPluginContextInput,
  env: NodeJS.ProcessEnv,
): PluginMetadataSnapshot {
  const inherited = getCurrentPluginMetadataSnapshot({
    config: input.config,
    env,
    workspaceDir: input.workspaceDir,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  // A nested runtime carries executable authority for one immutable graph.
  // Operation preparation must not replace it with another workspace's inventory.
  if (inherited && isScopedPluginMetadataSnapshotRuntimeGeneration(inherited)) {
    return inherited;
  }
  const scope =
    input.loadRuntimePlugins && input.runtimePluginSelections && input.workspaceDir
      ? {
          pluginIdScope: createAgentRuntimeMetadataPluginIdScope({
            config: input.config,
            workspaceDir: input.workspaceDir,
            selections: input.runtimePluginSelections,
          }),
        }
      : {};
  if (inherited && inherited.pluginIds === undefined) {
    return projectPluginMetadataSnapshot(
      inherited,
      scope.pluginIdScope?.resolve({ index: inherited.index }),
    );
  }
  const prepared = getCurrentPluginMetadataOwner()?.readSnapshot({
    config: input.config,
    env,
    workspaceDir: input.workspaceDir,
    allowWorkspaceScopedCurrent: true,
    ...scope,
  });
  if (prepared) {
    return prepared;
  }
  const metadata = preparePluginMetadata({
    config: input.config,
    env,
    workspaceDir: input.workspaceDir,
  });
  return getPluginMetadataWorkspaceSnapshot(metadata, {
    workspaceDir: input.workspaceDir,
    ...scope,
  });
}
