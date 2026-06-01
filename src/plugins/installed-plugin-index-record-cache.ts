import type { PluginInstallRecord } from "../config/types.plugins.js";

export type InstallRecordsCacheEntry = {
  records: Record<string, PluginInstallRecord>;
};

const installRecordsCache = new Map<string, InstallRecordsCacheEntry>();
let installRecordsCacheGeneration = 0;

export function getInstalledPluginIndexInstallRecordsCache(
  key: string,
): InstallRecordsCacheEntry | undefined {
  return installRecordsCache.get(key);
}

export function setInstalledPluginIndexInstallRecordsCache(
  key: string,
  entry: InstallRecordsCacheEntry,
): void {
  installRecordsCache.set(key, entry);
}

export function getInstalledPluginIndexInstallRecordsCacheGeneration(): number {
  return installRecordsCacheGeneration;
}

export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  installRecordsCacheGeneration += 1;
  installRecordsCache.clear();
}
