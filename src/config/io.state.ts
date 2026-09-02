import { createDedupeCache } from "../infra/dedupe.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";

const CONFIG_IO_WARNING_CACHE_MAX_SIZE = 4096;

// Warning state spans fresh config snapshots; bounding it means evicted paths can re-warn.
export const loggedInvalidConfigs = createDedupeCache({
  ttlMs: 0,
  maxSize: CONFIG_IO_WARNING_CACHE_MAX_SIZE,
});

export const loggedConfigWarningFingerprints = new Map<string, string>();

// Warning state spans fresh config snapshots; bounding it means evicted versions can re-warn.
export const warnedFutureTouchedVersions = createDedupeCache({
  ttlMs: 0,
  maxSize: CONFIG_IO_WARNING_CACHE_MAX_SIZE,
});

export const autoOwnerDisplaySecretByPath = new Map<string, string>();

/** Retains a warning fingerprint as most-recently used while enforcing the shared bound. */
export function setBoundedConfigIoWarningEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  pruneMapToMaxSize(map, CONFIG_IO_WARNING_CACHE_MAX_SIZE);
}
