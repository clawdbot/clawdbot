import type { PluginRegistry } from "./registry-types.js";

const retiredRegistries = new WeakSet<PluginRegistry>();

export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    retiredRegistries.add(registry);
  }
}

export function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    retiredRegistries.delete(registry);
  }
}

export function isPluginRegistryRetired(registry: PluginRegistry): boolean {
  return retiredRegistries.has(registry);
}
