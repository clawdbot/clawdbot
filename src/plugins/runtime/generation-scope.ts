import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRegistry } from "../registry-types.js";
import { withPluginRuntimeRegistryScope } from "./gateway-request-scope.js";
import { pluginRuntimeGenerationRegistryScope } from "./generation-state.js";

/** Carries one prepared plugin generation through all nested runtime lookups. */
export function withPluginRuntimeGenerationScope<T>(
  generation: {
    config: OpenClawConfig;
    metadataSnapshot: PluginMetadataSnapshot;
    pluginRegistry?: PluginRegistry;
  },
  run: () => T,
): T {
  const pluginRegistry = generation.pluginRegistry ?? createEmptyPluginRegistry();
  return withPluginMetadataSnapshotScope(
    generation.metadataSnapshot,
    () =>
      pluginRuntimeGenerationRegistryScope.run(pluginRegistry, () =>
        withPluginRuntimeRegistryScope(pluginRegistry, run),
      ),
    {
      config: generation.config,
      trustConfigIdentity: true,
      ...(generation.metadataSnapshot.workspaceDir
        ? { workspaceDir: generation.metadataSnapshot.workspaceDir }
        : {}),
    },
  );
}
