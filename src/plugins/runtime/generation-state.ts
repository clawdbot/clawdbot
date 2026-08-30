/** Shares the retained executable registry without importing metadata-scope installation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginRegistry } from "../registry-types.js";

const PLUGIN_RUNTIME_GENERATION_REGISTRY_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGenerationRegistryScope",
);

export const pluginRuntimeGenerationRegistryScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRegistry>
>(PLUGIN_RUNTIME_GENERATION_REGISTRY_SCOPE_KEY, () => new AsyncLocalStorage<PluginRegistry>());

/** Exact registry owned by the prepared generation, when one is active. */
export function getPluginRuntimeGenerationRegistry(): PluginRegistry | undefined {
  return pluginRuntimeGenerationRegistryScope.getStore();
}
