// Keep retained registry reads independent of metadata discovery and plugin loading.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginRegistry } from "../registry-types.js";

const registryScope = resolveGlobalSingleton<AsyncLocalStorage<PluginRegistry>>(
  Symbol.for("openclaw.pluginRuntimeGenerationRegistryScope"),
  () => new AsyncLocalStorage<PluginRegistry>(),
);

export function withPluginRuntimeGenerationRegistryScope<T>(
  registry: PluginRegistry,
  run: () => T,
): T {
  return registryScope.run(registry, run);
}

/** Exact registry owned by the prepared generation, including empty selections. */
export function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {
  return registryScope.getStore();
}
