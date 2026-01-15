import type { PluginRegistry } from "./registry.js";

let activeRegistry: PluginRegistry | null = null;
let activeRegistryKey: string | null = null;

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  activeRegistry = registry;
  activeRegistryKey = cacheKey ?? null;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return activeRegistry;
}

export function getActivePluginRegistryKey(): string | null {
  return activeRegistryKey;
}
