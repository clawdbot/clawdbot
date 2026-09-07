import { getPluginCache, getProcessPluginCache } from "./plugin-cache.js";

/** Explicit ledger writes/reloads leave the Gateway's embedded boot snapshot unchanged. */
export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  for (const cache of new Set([getPluginCache(), getProcessPluginCache()])) {
    cache.installRecords.clear();
    cache.persistedInstalledIndex.clear();
  }
}
