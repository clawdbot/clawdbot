/** Test-only registry type projections. */
import type { PluginRegistry } from "./registry.js";

export * from "./registry.js";

export type PluginProviderRegistration = PluginRegistry["providers"][number];
export type PluginMemoryEmbeddingProviderRegistration =
  PluginRegistry["memoryEmbeddingProviders"][number];
