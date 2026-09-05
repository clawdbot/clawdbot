/** Tracks active and retired plugin registries so stale runtime calls can be rejected. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginLoaderCacheState } from "./loader-cache-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;

export const pluginLoaderCacheState = new PluginLoaderCacheState<PluginRegistry>(
  MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
);

// Registry identities cross built/source module copies. Their activation and
// revocation state must share that lifetime, or valid owners fail and revocations split.
const { retiredRegistries, activatedRegistries, registryEpochs, recordEpochs, revokedRecordEpoch } =
  resolveGlobalSingleton(Symbol.for("openclaw.pluginRegistryLifecycle"), () => ({
    retiredRegistries: new WeakSet<PluginRegistry>(),
    activatedRegistries: new WeakSet<PluginRegistry>(),
    registryEpochs: new WeakMap<PluginRegistry, object>(),
    recordEpochs: new WeakMap<PluginRegistry, WeakMap<PluginRecord, object>>(),
    revokedRecordEpoch: Object.freeze({}),
  }));

export type PluginRegistryLifecycleEpoch = object;
type PluginRecordLifecycleEpoch = object;

/** Marks a registry retired so late runtime calls can reject stale plugin state. */
export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    retiredRegistries.add(registry);
    registryEpochs.delete(registry);
    // Retired registrations cannot be reused and retain their Gateway/cache generation.
    // Release every cache key now, including keys that will never be looked up again.
    pluginLoaderCacheState.deleteValue(registry);
  }
}

/** Marks a registry active and clears any previous retired state. */
export function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    activatedRegistries.add(registry);
    retiredRegistries.delete(registry);
    // Every activation owns a fresh opaque generation. A retired closure cannot
    // regain authority merely because the same registry object becomes active.
    registryEpochs.set(registry, Object.freeze({}));
  }
}

/** Capture the exact activation generation currently owned by a registry. */
export function capturePluginRegistryLifecycleEpoch(
  registry: PluginRegistry,
): PluginRegistryLifecycleEpoch | undefined {
  return retiredRegistries.has(registry) ? undefined : registryEpochs.get(registry);
}

/** True only while the exact captured registry activation remains current. */
export function isPluginRegistryLifecycleEpochActive(
  registry: PluginRegistry,
  epoch: PluginRegistryLifecycleEpoch,
): boolean {
  return !retiredRegistries.has(registry) && registryEpochs.get(registry) === epoch;
}

/** Mint the exact record generation used by one registered native channel runtime. */
export function activatePluginRecordLifecycleEpoch(
  registry: PluginRegistry,
  record: PluginRecord,
): PluginRecordLifecycleEpoch | undefined {
  const registryEpoch = registryEpochs.get(registry);
  if (!registryEpoch || retiredRegistries.has(registry)) {
    return undefined;
  }
  const epoch = Object.freeze({ registryEpoch });
  const epochs = recordEpochs.get(registry) ?? new WeakMap<PluginRecord, object>();
  epochs.set(record, epoch);
  recordEpochs.set(registry, epochs);
  return epoch;
}

/** Return an epoch only while its exact registry activation and record remain current. */
export function isPluginRecordLifecycleEpochActive(
  registry: PluginRegistry,
  record: PluginRecord,
  epoch: PluginRecordLifecycleEpoch,
): boolean {
  const registryEpoch = registryEpochs.get(registry);
  const epochRegistry = Object.getOwnPropertyDescriptor(epoch, "registryEpoch");
  return (
    registryEpoch !== undefined &&
    !retiredRegistries.has(registry) &&
    epochRegistry !== undefined &&
    "value" in epochRegistry &&
    epochRegistry.value === registryEpoch &&
    recordEpochs.get(registry)?.get(record) === epoch
  );
}

/** Revoke one record without changing unrelated records in the same registry. */
export function revokePluginRecordLifecycleEpoch(
  registry: PluginRegistry,
  record: PluginRecord,
): void {
  const epochs = recordEpochs.get(registry) ?? new WeakMap<PluginRecord, object>();
  epochs.set(record, revokedRecordEpoch);
  recordEpochs.set(registry, epochs);
}

/** True when a registry has been activated for runtime use. */
export function isPluginRegistryActivated(registry: PluginRegistry): boolean {
  return activatedRegistries.has(registry);
}

/** True when a registry has been retired by a newer active registry. */
export function isPluginRegistryRetired(registry: PluginRegistry): boolean {
  return retiredRegistries.has(registry);
}

/** Capture an activation; reactivating the same objects must not revive an old operation. */
export function capturePluginLifecycleAuthority(
  registry: PluginRegistry,
  record?: PluginRecord,
  options?: { scopedRuntime?: boolean },
): (() => boolean) | undefined {
  const epoch = registryEpochs.get(registry);
  const recordEpoch = record && recordEpochs.get(registry)?.get(record);
  if (
    (!epoch && !options?.scopedRuntime) ||
    retiredRegistries.has(registry) ||
    recordEpoch === revokedRecordEpoch
  ) {
    return undefined;
  }
  return () =>
    registryEpochs.get(registry) === epoch &&
    !retiredRegistries.has(registry) &&
    (!record ||
      (registry.plugins.includes(record) &&
        record.enabled &&
        record.status === "loaded" &&
        recordEpochs.get(registry)?.get(record) === recordEpoch));
}
