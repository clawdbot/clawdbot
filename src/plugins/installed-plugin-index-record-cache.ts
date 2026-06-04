// Caches installed plugin index records for current process lookups.
import type { PluginInstallRecord } from "../config/types.plugins.js";

/** Cached installed plugin records for one store/recovery key. */
export type InstallRecordsCacheEntry = {
  records: Record<string, PluginInstallRecord>;
};

const installRecordsCache = new Map<string, InstallRecordsCacheEntry>();
let installRecordsCacheGeneration = 0;

/** Returns cached installed plugin records for a store/recovery key. */
export function getInstalledPluginIndexInstallRecordsCache(
  key: string,
): InstallRecordsCacheEntry | undefined {
  return installRecordsCache.get(key);
}

/** Stores cached installed plugin records for a store/recovery key. */
export function setInstalledPluginIndexInstallRecordsCache(
  key: string,
  entry: InstallRecordsCacheEntry,
): void {
  installRecordsCache.set(key, entry);
}

/** Current cache generation used to detect concurrent clears during async loads. */
export function getInstalledPluginIndexInstallRecordsCacheGeneration(): number {
  return installRecordsCacheGeneration;
}

/** Clears cached installed plugin records and advances the cache generation. */
export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  installRecordsCacheGeneration += 1;
  installRecordsCache.clear();
}
