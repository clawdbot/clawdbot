import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources, type BridgeMemoryWikiResult } from "./bridge.js";
import {
  refreshMemoryWikiIndexesAfterImport,
  type RefreshMemoryWikiIndexesResult,
} from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

export type MemoryWikiImportedSourceSyncResult = BridgeMemoryWikiResult & {
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: RefreshMemoryWikiIndexesResult["reason"];
};

export async function syncMemoryWikiImportedSources(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}): Promise<MemoryWikiImportedSourceSyncResult> {
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
