type NamedPluginRuntimeStoreSlot = { runtime: unknown };
type NamedPluginRuntimeStoreRegistry = Map<string, NamedPluginRuntimeStoreSlot>;

const pluginRuntimeStoreRegistryKey = Symbol.for("openclaw.plugin-sdk.runtime-store-registry");

function getNamedPluginRuntimeStoreRegistry(): NamedPluginRuntimeStoreRegistry {
  const globalRecord = globalThis as typeof globalThis & {
    [pluginRuntimeStoreRegistryKey]?: NamedPluginRuntimeStoreRegistry;
  };
  globalRecord[pluginRuntimeStoreRegistryKey] ??= new Map();
  return globalRecord[pluginRuntimeStoreRegistryKey];
}

export function getNamedPluginRuntimeStoreSlot(key: string): NamedPluginRuntimeStoreSlot {
  const registry = getNamedPluginRuntimeStoreRegistry();
  let slot = registry.get(key);
  if (!slot) {
    slot = { runtime: null };
    registry.set(key, slot);
  }
  return slot;
}

export function clearNamedPluginRuntimeStoresForTest(): void {
  const registry = getNamedPluginRuntimeStoreRegistry();
  for (const slot of registry.values()) {
    slot.runtime = null;
  }
  registry.clear();
}
