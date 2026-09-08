import { withPluginMetadataSnapshotScope } from "../current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRegistry } from "../registry-types.js";
import { withPluginRuntimeRegistryScope } from "./gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./generation-state.js";

export { getPluginRuntimeGenerationRegistry } from "./generation-state.js";

/** Carries one prepared plugin generation through all nested runtime lookups. */
export function withPluginRuntimeGenerationScope<T>(
  generation: {
    metadataSnapshot: PluginMetadataSnapshot;
    pluginRegistry?: PluginRegistry;
  },
  run: () => T,
): T {
  const pluginRegistry = generation.pluginRegistry ?? createEmptyPluginRegistry();
  return withPluginMetadataSnapshotScope(
    generation.metadataSnapshot,
    () =>
      withPluginRuntimeGenerationRegistryScope(pluginRegistry, () =>
        withPluginRuntimeRegistryScope(
          pluginRegistry,
          run,
          generation.metadataSnapshot.declaredProviderOwners,
        ),
      ),
    // The prepared generation already owns discovery and policy compatibility.
    { trustConfigIdentity: true },
  );
}
