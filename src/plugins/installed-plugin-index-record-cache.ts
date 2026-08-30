import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { getPluginCache, getProcessPluginCache } from "./plugin-cache.js";

// The revision fences unpublished metadata across source/ESM readers; facts live in PluginCache.
const sourceState = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstallRecordsSourceRevision"),
  () => ({
    generation: 0,
    initializationGeneration: 0,
    openedDatabases: new WeakSet<OpenClawStateDatabase>(),
  }),
);

export function getInstalledPluginIndexInstallRecordsCacheGeneration(): number {
  return sourceState.generation;
}

/** Preparation before authoritative state initialization cannot become a retained read. */
export function getInstalledPluginIndexInitializationGeneration(): number {
  return sourceState.initializationGeneration;
}

/** Explicit ledger writes/reloads leave retained operation and Gateway inventories unchanged. */
export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  sourceState.generation += 1;
  for (const cache of new Set([getPluginCache(), getProcessPluginCache()])) {
    cache.installRecords.clear();
    cache.persistedInstalledIndex.clear();
    if (cache.kind === "process" && cache.metadata.current.owner !== "gateway") {
      cache.metadata.collectionOwner?.invalidatePreparation();
    }
  }
}

// Read-only preflight can precede database initialization. Opening an authoritative
// database invalidates that preparation once, including replay through a second module instance.
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened" || sourceState.openedDatabases.has(event.database)) {
    return;
  }
  sourceState.openedDatabases.add(event.database);
  clearLoadInstalledPluginIndexInstallRecordsCache();
  sourceState.initializationGeneration = sourceState.generation;
});
