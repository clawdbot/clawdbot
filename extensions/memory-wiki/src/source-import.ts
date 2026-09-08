import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import type { writeImportedSourcePage } from "./source-page-shared.js";
import {
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

export type BridgeMemoryWikiResult = {
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  removedCount: number;
  artifactCount: number;
  workspaces: number;
  pagePaths: string[];
};

type ImportedSourceBatch = {
  results: Awaited<ReturnType<typeof writeImportedSourcePage>>[];
  activeKeys: Set<string>;
  artifactCount: number;
  workspaces: number;
};

export async function syncImportedSourcePages(params: {
  config: ResolvedMemoryWikiConfig;
  group: MemoryWikiImportedSourceGroup;
  signal?: AbortSignal;
  writeSources: (context: {
    state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
    prepareWrite: () => Promise<unknown>;
  }) => Promise<ImportedSourceBatch>;
  canPrune?: () => boolean;
  logDetails: (batch: ImportedSourceBatch) => Record<string, number>;
}): Promise<BridgeMemoryWikiResult> {
  const state = await readMemoryWikiSourceSyncState(params.config.vault.path);
  let initializePromise: ReturnType<typeof initializeMemoryWikiVault> | undefined;
  const prepareWrite = async () => {
    params.signal?.throwIfAborted();
    const result = await (initializePromise ??= initializeMemoryWikiVault(
      params.config,
      params.signal ? { signal: params.signal } : undefined,
    ));
    params.signal?.throwIfAborted();
    return result;
  };
  const batch = await params.writeSources({ state, prepareWrite });
  // Recheck source-owned pruning authority after all awaited imports.
  const removedCount =
    !params.canPrune || params.canPrune()
      ? await pruneImportedSourceEntries({
          vaultRoot: params.config.vault.path,
          group: params.group,
          activeKeys: batch.activeKeys,
          state,
          prepareWrite,
        })
      : 0;
  await writeMemoryWikiSourceSyncState(params.config.vault.path, state);
  const importedCount = batch.results.filter((result) => result.changed && result.created).length;
  const updatedCount = batch.results.filter((result) => result.changed && !result.created).length;
  const skippedCount = batch.results.filter((result) => !result.changed).length;
  const pagePaths = batch.results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "ingest",
      timestamp: new Date().toISOString(),
      details: {
        sourceType: `memory-${params.group}`,
        ...params.logDetails(batch),
        artifactCount: batch.artifactCount,
        importedCount,
        updatedCount,
        skippedCount,
        removedCount,
      },
    });
  }

  return {
    importedCount,
    updatedCount,
    skippedCount,
    removedCount,
    artifactCount: batch.artifactCount,
    workspaces: batch.workspaces,
    pagePaths,
  };
}
