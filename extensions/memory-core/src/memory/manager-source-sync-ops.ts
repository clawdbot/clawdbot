// Memory Core plugin module owns memory and session source indexing.
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  parseSqliteSessionFileMarker,
  parseUsageCountedSessionIdFromFileName,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  buildFileEntry,
  listMemoryFiles,
  MEMORY_INDEX_FTS_TABLE,
  runWithConcurrency,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MemoryManagerSessionSyncOps } from "./manager-session-sync-ops.js";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";
import type {
  MemoryIndexEntry,
  MemoryIndexWorkItem,
  MemorySourceSyncPlan,
  MemorySyncProgressState,
} from "./manager-sync-base.js";

const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const SESSION_SYNC_YIELD_EVERY = 10;
const SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES = 128;
const log = createSubsystemLogger("memory");

function createSessionSyncYield(total: number): () => Promise<void> {
  let completed = 0;
  return async () => {
    completed += 1;
    if (completed < total && completed % SESSION_SYNC_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  };
}

export abstract class MemoryManagerSourceSyncOps extends MemoryManagerSessionSyncOps {
  protected override async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
    deferIndex?: boolean;
  }): Promise<MemorySourceSyncPlan> {
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM memory_index_sources WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM memory_index_chunks WHERE path = ? AND source = ?`,
    );
    const deleteFtsRowsByPathAndSource =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
        : null;

    const files = await listMemoryFiles(
      this.workspaceDir,
      this.settings.extraPaths,
      this.settings.multimodal,
    );
    const fileEntries = (
      await runWithConcurrency(
        files.map(
          (file) => async () =>
            await buildFileEntry(file, this.workspaceDir, this.settings.multimodal),
        ),
        this.getIndexConcurrency(),
      )
    ).filter((entry): entry is MemoryIndexEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const existingState = loadMemorySourceFileState({
      db: this.db,
      source: "memory",
    });
    const existingRows = existingState.rows;
    const existingHashes = existingState.hashes;
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const deleteStaleRows = async () => {
      for (const stale of existingRows) {
        if (activePaths.has(stale.path)) {
          continue;
        }
        deleteFileByPathAndSource.run(stale.path, "memory");
        this.deleteVectorRowsForSource(stale.path, "memory");
        deleteChunksByPathAndSource.run(stale.path, "memory");
        if (deleteFtsRowsByPathAndSource) {
          try {
            deleteFtsRowsByPathAndSource.run(stale.path, "memory");
          } catch {}
        }
      }
    };

    if (this.batch.enabled) {
      const dirtyEntries: MemoryIndexEntry[] = [];
      for (const entry of fileEntries) {
        if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          continue;
        }
        dirtyEntries.push(entry);
      }
      const indexItems = dirtyEntries.map(
        (entry): MemoryIndexWorkItem => ({ entry, source: "memory" }),
      );
      if (params.deferIndex) {
        return { indexItems, finalize: deleteStaleRows };
      }
      await this.indexQueuedFiles(indexItems, params.progress);
    } else {
      const tasks = fileEntries.map((entry) => async () => {
        if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          return;
        }
        await this.indexFile(entry, { source: "memory" });
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
      });
      await runWithConcurrency(tasks, this.getIndexConcurrency());
    }

    await deleteStaleRows();
    return this.emptySourceSyncPlan();
  }

  protected override async syncArchiveFiles(params: {
    needsFullReindex: boolean;
    targetArchiveFiles?: string[];
    progress?: MemorySyncProgressState;
    deferIndex?: boolean;
    prefixIndexItems?: MemoryIndexWorkItem[];
  }): Promise<MemorySourceSyncPlan> {
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM memory_index_sources WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM memory_index_chunks WHERE path = ? AND source = ?`,
    );
    const deleteFtsRowsByPathAndSource =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
        : null;

    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    const targetArchiveFiles = params.needsFullReindex
      ? null
      : this.normalizeTargetArchiveFiles(params.targetArchiveFiles, corpusEntries);
    const corpusEntryByPath = new Map<string, SessionTranscriptCorpusEntry>(
      corpusEntries.map((entry) => [entry.sessionFile, entry]),
    );
    const files = targetArchiveFiles
      ? Array.from(targetArchiveFiles)
      : corpusEntries.map((entry) => entry.sessionFile);
    const sessionPlan = resolveMemorySessionSyncPlan({
      needsFullReindex: params.needsFullReindex,
      files,
      targetSessionFiles: targetArchiveFiles,
      sessionsDirtyFiles: this.sessionsDirtyFiles,
      existingRows: targetArchiveFiles
        ? null
        : loadMemorySourceFileState({
            db: this.db,
            source: "sessions",
          }).rows,
      sessionPathForFile: (file) => {
        const corpusEntry = corpusEntryByPath.get(file);
        if (corpusEntry) {
          return this.sessionPathForCorpusEntry(corpusEntry);
        }
        const sqliteMarker = parseSqliteSessionFileMarker(file);
        return sqliteMarker
          ? sessionPathForSessionIdentity(sqliteMarker.agentId, sqliteMarker.sessionId)
          : sessionPathForFile(file);
      },
    });
    const { activePaths, existingRows, existingHashes, indexAll } = sessionPlan;
    log.debug("memory sync: indexing session files", {
      files: files.length,
      indexAll,
      dirtyFiles: this.sessionsDirtyFiles.size,
      targetedFiles: targetArchiveFiles?.size ?? 0,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
      });
    }

    const yieldAfterSessionFile = createSessionSyncYield(files.length);
    const deleteIndexedSessionPath = (memoryPath: string) => {
      deleteFileByPathAndSource.run(memoryPath, "sessions");
      this.deleteVectorRowsForSource(memoryPath, "sessions");
      deleteChunksByPathAndSource.run(memoryPath, "sessions");
      if (deleteFtsRowsByPathAndSource) {
        try {
          deleteFtsRowsByPathAndSource.run(memoryPath, "sessions");
        } catch {}
      }
    };
    const deleteStaleRows = async () => {
      if (activePaths === null) {
        return;
      }

      const staleRows = existingRows ?? [];
      const yieldAfterStaleSessionRow = createSessionSyncYield(staleRows.length);
      for (const stale of staleRows) {
        try {
          if (activePaths.has(stale.path)) {
            continue;
          }
          deleteIndexedSessionPath(stale.path);
        } finally {
          await yieldAfterStaleSessionRow();
        }
      }
    };
    const deleteTargetArchiveStaleLiveRows = () => {
      if (!targetArchiveFiles) {
        return;
      }
      const activeCorpusPaths = new Set(
        corpusEntries
          .filter((entry) => entry.artifactKind === "active-session")
          .map((entry) => this.sessionPathForCorpusEntry(entry)),
      );
      const existingSessionPaths = new Set(
        loadMemorySourceFileState({
          db: this.db,
          source: "sessions",
        }).rows.map((row) => row.path),
      );
      for (const file of targetArchiveFiles) {
        const corpusEntry = corpusEntryByPath.get(file);
        const sqliteMarker = parseSqliteSessionFileMarker(file);
        const sessionId =
          corpusEntry?.sessionId ??
          sqliteMarker?.sessionId ??
          parseUsageCountedSessionIdFromFileName(path.basename(file));
        if (!sessionId) {
          continue;
        }
        const staleAgentId = corpusEntry?.agentId ?? sqliteMarker?.agentId ?? this.agentId;
        const staleLivePaths = [
          sessionPathForSessionIdentity(staleAgentId, sessionId),
          this.legacyExtensionlessSessionPathForIdentity(staleAgentId, sessionId),
        ];
        for (const staleLivePath of staleLivePaths) {
          if (activeCorpusPaths.has(staleLivePath) || !existingSessionPaths.has(staleLivePath)) {
            continue;
          }
          deleteIndexedSessionPath(staleLivePath);
        }
      }
    };

    if (params.deferIndex) {
      const pendingIndexItems = [...(params.prefixIndexItems ?? [])];
      const flushPendingIndexItems = async () => {
        if (pendingIndexItems.length === 0) {
          return;
        }
        const current = pendingIndexItems.splice(0);
        const sources = new Set(current.map((item) => item.source));
        await this.indexQueuedFiles(
          current,
          params.progress,
          sources.size > 1 ? "Indexing memory sources (batch)..." : undefined,
        );
      };

      // Session entries carry flattened transcript content; flush bounded groups
      // so source-wide batching cannot retain the whole dirty transcript corpus.
      for (let start = 0; start < files.length; start += SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES) {
        const fileBatch = files.slice(start, start + SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES);
        const dirtyEntries = (
          await runWithConcurrency(
            fileBatch.map((absPath) => async (): Promise<MemoryIndexEntry | null> => {
              try {
                if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
                  if (params.progress) {
                    params.progress.completed += 1;
                    params.progress.report({
                      completed: params.progress.completed,
                      total: params.progress.total,
                    });
                  }
                  return null;
                }
                const corpusEntry = corpusEntryByPath.get(absPath);
                const entry = await buildSessionEntry(
                  absPath,
                  corpusEntry ? this.buildSessionEntryOptions(corpusEntry) : undefined,
                );
                if (!entry) {
                  if (params.progress) {
                    params.progress.completed += 1;
                    params.progress.report({
                      completed: params.progress.completed,
                      total: params.progress.total,
                    });
                  }
                  return null;
                }
                const existingHash = resolveMemorySourceExistingHash({
                  db: this.db,
                  source: "sessions",
                  path: entry.path,
                  existingHashes,
                });
                if (!params.needsFullReindex && existingHash === entry.hash) {
                  if (params.progress) {
                    params.progress.completed += 1;
                    params.progress.report({
                      completed: params.progress.completed,
                      total: params.progress.total,
                    });
                  }
                  this.resetSessionDelta(absPath, entry.size);
                  return null;
                }
                return entry;
              } finally {
                await yieldAfterSessionFile();
              }
            }),
            this.getIndexConcurrency(),
          )
        ).filter((entry): entry is MemoryIndexEntry => entry !== null);
        pendingIndexItems.push(
          ...dirtyEntries.map(
            (entry): MemoryIndexWorkItem => ({
              entry,
              source: "sessions",
              afterIndex: () => this.resetSessionDelta(entry.absPath, entry.size),
            }),
          ),
        );
        if (pendingIndexItems.length >= SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES) {
          await flushPendingIndexItems();
        }
      }

      await flushPendingIndexItems();
      deleteTargetArchiveStaleLiveRows();
      await deleteStaleRows();
      return this.emptySourceSyncPlan();
    }
    if ((params.prefixIndexItems?.length ?? 0) > 0) {
      throw new Error("Memory session sync prefix requires deferred source-wide indexing.");
    }

    const tasks = files.map((absPath) => async () => {
      try {
        if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          return;
        }
        const corpusEntry = corpusEntryByPath.get(absPath);
        const entry = await buildSessionEntry(
          absPath,
          corpusEntry ? this.buildSessionEntryOptions(corpusEntry) : undefined,
        );
        if (!entry) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          return;
        }
        const existingHash = resolveMemorySourceExistingHash({
          db: this.db,
          source: "sessions",
          path: entry.path,
          existingHashes,
        });
        if (!params.needsFullReindex && existingHash === entry.hash) {
          if (params.progress) {
            params.progress.completed += 1;
            params.progress.report({
              completed: params.progress.completed,
              total: params.progress.total,
            });
          }
          this.resetSessionDelta(absPath, entry.size);
          return;
        }
        await this.indexFile(entry, { source: "sessions", content: entry.content });
        this.resetSessionDelta(absPath, entry.size);
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
      } finally {
        await yieldAfterSessionFile();
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    deleteTargetArchiveStaleLiveRows();
    await deleteStaleRows();
    return this.emptySourceSyncPlan();
  }
}
