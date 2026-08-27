import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { withPluginMetadataSnapshotScope } from "../current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRegistry } from "../registry-types.js";
import { withPluginRuntimeRegistryScope } from "./gateway-request-scope.js";

const PLUGIN_RUNTIME_GENERATION_REGISTRY_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGenerationRegistryScope",
);

const pluginRuntimeGenerationRegistryScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRegistry>
>(PLUGIN_RUNTIME_GENERATION_REGISTRY_SCOPE_KEY, () => new AsyncLocalStorage<PluginRegistry>());

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

/** Exact registry owned by the prepared generation, when one is active. */
export function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {
  return pluginRuntimeGenerationRegistryScope.getStore();
}
