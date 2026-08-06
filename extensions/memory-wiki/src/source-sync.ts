// Memory Wiki plugin module implements source sync behavior.
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources, type BridgeMemoryWikiResult } from "./bridge.js";
import {
  refreshMemoryWikiIndexesAfterImport,
  type RefreshMemoryWikiIndexesResult,
} from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  resolveMemoryWikiVaultMutationKey,
  withMemoryWikiVaultMutation,
} from "./mutation-coordinator.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

export type MemoryWikiImportedSourceSyncResult = BridgeMemoryWikiResult & {
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: RefreshMemoryWikiIndexesResult["reason"];
};

type SyncMemoryWikiImportedSourcesParams = {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
};

type ActiveImportedSourceSync = {
  requestKey: string;
  appConfig?: OpenClawConfig;
  promise: Promise<MemoryWikiImportedSourceSyncResult>;
};

const activeImportedSourceSyncs = new Map<string, ActiveImportedSourceSync[]>();

function resolveImportedSourceSyncRequestKey(
  params: SyncMemoryWikiImportedSourcesParams,
  vaultKey: string,
): string {
  return JSON.stringify({
    ...params.config,
    vault: {
      ...params.config.vault,
      path: vaultKey,
    },
  });
}

async function syncMemoryWikiImportedSourcesOnce(
  params: SyncMemoryWikiImportedSourcesParams,
): Promise<MemoryWikiImportedSourceSyncResult> {
  let syncResult: BridgeMemoryWikiResult;
  if (params.config.vaultMode === "bridge") {
    syncResult = await syncMemoryWikiBridgeSources(params);
  } else if (params.config.vaultMode === "unsafe-local") {
    syncResult = await syncMemoryWikiUnsafeLocalSources(params.config);
  } else {
    syncResult = {
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    };
  }
  const refreshResult = await refreshMemoryWikiIndexesAfterImport({
    config: params.config,
    syncResult,
  });
  return {
    ...syncResult,
    indexesRefreshed: refreshResult.refreshed,
    indexUpdatedFiles: refreshResult.compile?.updatedFiles ?? [],
    indexRefreshReason: refreshResult.reason,
  };
}

export async function syncMemoryWikiImportedSources(
  params: SyncMemoryWikiImportedSourcesParams,
): Promise<MemoryWikiImportedSourceSyncResult> {
  const vaultKey = await resolveMemoryWikiVaultMutationKey(params.config.vault.path);
  const requestKey = resolveImportedSourceSyncRequestKey(params, vaultKey);
  const active = activeImportedSourceSyncs.get(vaultKey) ?? [];
  const matching = active.find(
    (entry) => entry.requestKey === requestKey && entry.appConfig === params.appConfig,
  );
  if (matching) {
    return await matching.promise;
  }

  // Equivalent polls share the whole source-and-index flight. Different
  // snapshots still queue on the common vault transaction boundary.
  const promise = withMemoryWikiVaultMutation(params.config.vault.path, () =>
    syncMemoryWikiImportedSourcesOnce(params),
  );
  const entry: ActiveImportedSourceSync = {
    requestKey,
    ...(params.appConfig ? { appConfig: params.appConfig } : {}),
    promise,
  };
  active.push(entry);
  activeImportedSourceSyncs.set(vaultKey, active);

  try {
    return await promise;
  } finally {
    const index = active.indexOf(entry);
    if (index >= 0) {
      active.splice(index, 1);
    }
    if (active.length === 0 && activeImportedSourceSyncs.get(vaultKey) === active) {
      activeImportedSourceSyncs.delete(vaultKey);
    }
  }
}
