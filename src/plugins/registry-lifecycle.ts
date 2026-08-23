/** Tracks active and retired plugin registries so stale runtime calls can be rejected. */
import type { PluginRegistry } from "./registry-types.js";

const retiredRegistries = new WeakSet<PluginRegistry>();
const activatedRegistries = new WeakSet<PluginRegistry>();

/** Marks a registry retired so late runtime calls can reject stale plugin state. */
export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    retiredRegistries.add(registry);
  }
}

/** Marks a registry active and clears any previous retired state. */
export function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    activatedRegistries.add(registry);
    retiredRegistries.delete(registry);
  }
}

/** True when a registry has been activated for runtime use. */
export function isPluginRegistryActivated(registry: PluginRegistry): boolean {
  return activatedRegistries.has(registry);
}

/** True when a registry has been retired by a newer active registry. */
export function isPluginRegistryRetired(registry: PluginRegistry): boolean {
  return retiredRegistries.has(registry);
}
