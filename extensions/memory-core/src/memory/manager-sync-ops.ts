// Memory Core plugin module coordinates synchronization and shadow reindexing.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySyncParams,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { createEmbeddingProvider } from "./embeddings.js";
import {
  cleanupAgedMemoryReindexTempFiles,
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
  publishMemoryDatabaseTables,
  readMemoryDatabaseRevision,
  removeMemoryDatabaseFiles,
} from "./manager-db.js";
import { isMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  applyMemoryFallbackProviderState,
  resolveFallbackCurrentProviderId,
  resolveMemoryFallbackProviderRequest,
} from "./manager-provider-state.js";
import { acquireMemoryReindexLock, type MemoryReindexLockHandle } from "./manager-reindex-lock.js";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  resolveMemoryIndexIdentityState,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";
import { MemoryManagerSourceSyncOps } from "./manager-source-sync-ops.js";
import { MEMORY_INDEX_META_KEY, type MemorySyncProgressState } from "./manager-sync-base.js";
import {
  markMemoryTargetArchiveFilesDirty,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

export type { MemoryIndexWorkItem } from "./manager-sync-base.js";

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerSyncOps extends MemoryManagerSourceSyncOps {
  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  private assertFtsOnlySyncAllowed(): void {
    if (this.provider) {
      return;
    }
    this.assertRequiredProviderAvailable("sync");
    const existingMeta = this.readMeta();
    if (
      !existingMeta ||
      existingMeta.model === "fts-only" ||
      !this.settings.provider ||
      this.settings.provider === "none"
    ) {
      return;
    }
    this.resetProviderInitializationForRetry();
    throw new Error(
      `Memory sync aborted: embedding provider "${this.settings.provider}" is configured but unavailable. ` +
        `Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: ${existingMeta.model}).`,
    );
  }

  protected async runSync(params?: MemorySyncParams) {
    // Guard: if an embedding provider is configured but currently unavailable,
    // abort sync to prevent silently degrading an existing semantic vector index
    // to fts-only and wiping existing semantic vectors.
    // This only protects existing semantic indexes; fresh or already-fts-only
    // indexes can safely sync without an embedding provider.
    this.assertFtsOnlySyncAllowed();

    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const targetArchiveFiles = await this.combineTargetArchiveFiles({
      sessions: params?.sessions,
      archiveFiles: params?.archiveFiles,
    });
    const hasTargetArchiveFiles = targetArchiveFiles !== null;
    if (this.hasRequestedTargetSessionSync(params) && !hasTargetArchiveFiles) {
      return;
    }
    if (params?.reason === "cli" && !params.force && !hasTargetArchiveFiles) {
      await this.markSessionStartupCatchupDirtyFiles();
    }
    const indexIdentity = resolveMemoryIndexIdentityState({
      meta,
      // Also detects provider→FTS-only transitions so orphaned old-model FTS rows are cleaned up.
      provider: this.provider ? { id: this.provider.id, model: this.provider.model } : null,
      providerKey: this.providerKey ?? undefined,
      providerAliases: this.resolveProviderIndexIdentities().slice(1),
      configuredSources: resolveConfiguredSourcesForMeta(this.sources),
      configuredScopeHash: resolveConfiguredScopeHash({
        workspaceDir: this.workspaceDir,
        extraPaths: this.settings.extraPaths,
        multimodal: {
          enabled: this.settings.multimodal.enabled,
          modalities: this.settings.multimodal.modalities,
          maxFileBytes: this.settings.multimodal.maxFileBytes,
        },
      }),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      vectorReady,
      hasIndexedChunks: this.hasIndexedChunks(),
      ftsTokenizer: this.settings.store.fts.tokenizer,
    });
    const hasIndexedChunks = this.hasIndexedChunks();
    const needsInitialIndex = indexIdentity.status !== "valid" && !hasIndexedChunks;
    // Missing metadata cannot prove whether existing chunks were semantic.
    // Wait for the configured provider before replacing them with a rebuilt index,
    // unless every existing chunk is FTS-only — in that case rebuilding as
    // FTS-only is safe even without a provider because no semantic data is lost.
    // Gate the chunk-model scan: only compute when identity is missing,
    // chunks exist, and the provider is unavailable (no target session files
    // is already checked by needsMissingIdentityReindex below).
    const needsFtsOnlyClassification =
      indexIdentity.status === "missing" &&
      hasIndexedChunks &&
      this.provider === null &&
      Boolean(this.settings.provider) &&
      this.settings.provider !== "none";
    const hasOnlyFtsChunks = needsFtsOnlyClassification && !this.hasSemanticChunks();
    const canRebuildMissingIdentity =
      this.provider !== null ||
      !this.settings.provider ||
      this.settings.provider === "none" ||
      hasOnlyFtsChunks;
    const needsMissingIdentityReindex =
      indexIdentity.status === "missing" && !hasTargetArchiveFiles && canRebuildMissingIdentity;
    const needsExplicitIdentityReindex =
      params?.reason === "cli" && indexIdentity.status !== "valid" && !hasTargetArchiveFiles;
    const canRunRetryFullReindex =
      indexIdentity.status !== "missing" || needsInitialIndex || canRebuildMissingIdentity;
    const needsFullReindex =
      (params?.force && !hasTargetArchiveFiles) ||
      needsInitialIndex ||
      needsMissingIdentityReindex ||
      needsExplicitIdentityReindex ||
      (this.memoryFullRetryDirty && canRunRetryFullReindex) ||
      (this.sessionsFullRetryDirty && indexIdentity.status !== "valid" && canRunRetryFullReindex);
    const needsFullSessionReindex = needsFullReindex || this.sessionsFullRetryDirty;
    if (indexIdentity.status !== "valid" && !needsFullReindex) {
      this.dirty = true;
      const sessionsDirty = markMemoryTargetArchiveFilesDirty({
        sessionsDirtyFiles: this.sessionsDirtyFiles,
        targetArchiveFiles,
      });
      if (sessionsDirty) {
        this.sessionsDirty = true;
      }
      return;
    }
    if (!needsFullSessionReindex) {
      const targetedSessionSync = await runMemoryTargetedSessionSync({
        hasSessionSource: this.sources.has("sessions"),
        targetArchiveFiles,
        reason: params?.reason,
        progress: progress ?? undefined,
        sessionsFullRetryDirty: this.sessionsFullRetryDirty,
        sessionsDirtyFiles: this.sessionsDirtyFiles,
        syncArchiveFiles: async (targetedParams) => {
          await this.syncArchiveFiles(targetedParams);
        },
        shouldFallbackOnError: (err) => this.shouldFallbackOnError(err),
        activateFallbackProvider: async (reason) => await this.activateFallbackProvider(reason),
      });
      if (targetedSessionSync.handled) {
        this.sessionsDirty = targetedSessionSync.sessionsDirty;
        return;
      }
    }
    try {
      if (needsFullReindex) {
        await this.runInPlaceReindex({
          reason: params?.reason,
          force: params?.force,
          progress: progress ?? undefined,
        });
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") &&
        ((!hasTargetArchiveFiles && params?.force) || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (this.shouldDeferSourceWideBatch()) {
        await this.executeSourceWideSync({
          shouldSyncMemory,
          shouldSyncSessions,
          needsFullReindex,
          needsFullSessionReindex,
          targetArchiveFiles: targetArchiveFiles ? Array.from(targetArchiveFiles) : undefined,
          progress: progress ?? undefined,
        });
        if (shouldSyncMemory) {
          this.clearMemoryRetryState();
        }
        if (shouldSyncSessions) {
          this.clearSessionRetryState();
        } else {
          this.refreshSessionDirtyFlag();
        }
      } else {
        if (shouldSyncMemory) {
          await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
          this.clearMemoryRetryState();
        }

        if (shouldSyncSessions) {
          await this.syncArchiveFiles({
            needsFullReindex: needsFullSessionReindex,
            targetArchiveFiles: targetArchiveFiles ? Array.from(targetArchiveFiles) : undefined,
            progress: progress ?? undefined,
          });
          this.clearSessionRetryState();
        } else {
          this.refreshSessionDirtyFlag();
        }
      }
    } catch (err) {
      const reason = formatErrorMessage(err);
      const activated =
        this.shouldFallbackOnError(err) && (await this.activateFallbackProvider(reason));
      if (activated) {
        if (needsFullReindex && !hasTargetArchiveFiles) {
          await this.runInPlaceReindex({
            reason: params?.reason ?? "fallback",
            force: true,
            progress: progress ?? undefined,
          });
        }
        return;
      }
      if (!this.provider && this.fts.enabled && this.shouldFallbackOnError(err)) {
        log.warn(`memory embeddings unavailable; leaving memory index dirty: ${reason}`);
        return;
      }
      throw err;
    }
  }

  protected shouldFallbackOnError(err: unknown): boolean {
    return isMemoryEmbeddingOperationError(err);
  }

  private hasRequestedTargetSessionSync(params?: MemorySyncParams): boolean {
    return Boolean(
      params?.sessions?.some((session) => session.sessionId.trim().length > 0) ||
      params?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0),
    );
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(batch?.enabled && this.provider && this.providerRuntime?.batchEmbed);
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: resolveTimerTimeoutMs((batch?.timeoutMinutes ?? 60) * 60 * 1000, 60 * 60_000),
    };
  }

  protected async activateFallbackProvider(reason: string): Promise<boolean> {
    const currentProviderId = resolveFallbackCurrentProviderId({
      provider: this.provider,
      lifecycle: this.providerLifecycle,
    });
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      settings: this.settings,
      currentProviderId,
    });
    if (!fallbackRequest || !currentProviderId) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }

    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      ...(this.acquireLocalService ? { acquireLocalService: this.acquireLocalService } : {}),
      ...fallbackRequest,
    });

    const fallbackState = applyMemoryFallbackProviderState({
      current: {
        provider: this.provider,
        fallbackFrom: this.fallbackFrom,
        fallbackReason: this.fallbackReason,
        providerUnavailableReason: undefined,
        providerRuntime: this.providerRuntime,
        lifecycle: this.providerLifecycle,
      },
      fallbackFrom: currentProviderId,
      reason,
      result: fallbackResult,
    });
    this.fallbackFrom = fallbackState.fallbackFrom;
    this.fallbackReason = fallbackState.fallbackReason;
    this.provider = fallbackState.provider;
    this.providerRuntime = fallbackState.providerRuntime;
    this.providerUnavailableReason = fallbackState.providerUnavailableReason;
    this.providerLifecycle = fallbackState.lifecycle;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, {
      reason,
    });
    return true;
  }

  private async runInPlaceReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    // Build outside the shared agent DB, then publish only memory-owned tables
    // in one short transaction so failed rebuilds leave the current index usable.
    const dbPath = resolveUserPath(this.settings.store.databasePath);
    const tempDbPath = `${dbPath}.memory-reindex-${randomUUID()}`;
    const originalDb = this.db;
    let reindexLock: MemoryReindexLockHandle | undefined;
    let tempDb: DatabaseSync | undefined;
    let tempDbClosed = false;
    const originalRetryState = this.snapshotReindexRetryState();
    const shouldRetryMemoryOnFailure = this.sources.has("memory");
    const shouldRetrySessionsOnFailure = this.shouldSyncSessions(
      { reason: params.reason, force: params.force },
      true,
    );
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      lastMetaSerialized: this.lastMetaSerialized,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorDegradedWriteWarningShown: this.vectorDegradedWriteWarningShown,
      vectorReady: this.vectorReady,
    };
    const restoreOriginalState = () => {
      this.db = originalDb;
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.lastMetaSerialized = originalState.lastMetaSerialized;
      this.vector.available = originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorDegradedWriteWarningShown = originalState.vectorDegradedWriteWarningShown;
      this.vectorReady = originalState.vectorReady;
    };
    try {
      cleanupAgedMemoryReindexTempFiles(dbPath);
      reindexLock = acquireMemoryReindexLock(dbPath);
      const originalRevision = readMemoryDatabaseRevision(originalDb);
      tempDb = openMemoryDatabaseAtPath(tempDbPath, this.settings.store.vector.enabled);
      this.db = tempDb;
      this.lastMetaSerialized = null;
      this.resetVectorState();
      this.fts.available = false;
      this.fts.loadError = undefined;
      this.ensureSchema();
      await this.seedEmbeddingCache(originalDb);

      const shouldSyncMemory = shouldRetryMemoryOnFailure;
      const shouldSyncSessions = shouldRetrySessionsOnFailure;

      if (this.shouldDeferSourceWideBatch()) {
        await this.executeSourceWideSync({
          shouldSyncMemory,
          shouldSyncSessions,
          needsFullReindex: true,
          progress: params.progress,
        });
        if (shouldSyncMemory) {
          this.clearMemoryRetryState();
        }
        if (shouldSyncSessions) {
          this.clearSessionRetryState();
        } else {
          this.refreshSessionDirtyFlag();
        }
      } else {
        if (shouldSyncMemory) {
          await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
          this.clearMemoryRetryState();
        }

        if (shouldSyncSessions) {
          await this.syncArchiveFiles({ needsFullReindex: true, progress: params.progress });
          this.clearSessionRetryState();
        } else {
          this.refreshSessionDirtyFlag();
        }
      }
      if (!shouldSyncMemory) {
        this.dirty = false;
      }

      const nextMeta: MemoryIndexMeta = {
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey!,
        sources: resolveConfiguredSourcesForMeta(this.sources),
        scopeHash: resolveConfiguredScopeHash({
          workspaceDir: this.workspaceDir,
          extraPaths: this.settings.extraPaths,
          multimodal: {
            enabled: this.settings.multimodal.enabled,
            modalities: this.settings.multimodal.modalities,
            maxFileBytes: this.settings.multimodal.maxFileBytes,
          },
        }),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        ftsTokenizer: this.settings.store.fts.tokenizer,
      };
      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta);
      this.pruneEmbeddingCacheIfNeeded?.();
      const nextFtsState = {
        available: this.fts.available,
        loadError: this.fts.loadError,
      };

      closeMemoryDatabase(tempDb);
      tempDbClosed = true;
      await publishMemoryDatabaseTables({
        targetDb: originalDb,
        sourcePath: tempDbPath,
        metaKey: MEMORY_INDEX_META_KEY,
        expectedRevision: originalRevision,
        vectorExtensionPath: this.vector.extensionPath,
      });

      this.db = originalDb;
      this.resetVectorState();
      this.fts.available = nextFtsState.available;
      this.fts.loadError = nextFtsState.loadError;
      this.vector.dims = nextMeta.vectorDims;
    } catch (err) {
      if (tempDb && !tempDbClosed) {
        try {
          closeMemoryDatabase(tempDb);
          tempDbClosed = true;
        } catch {}
      }
      restoreOriginalState();
      this.restoreReindexRetryState(originalRetryState);
      this.markFailedFullReindexRetry({
        memory: shouldRetryMemoryOnFailure,
        sessions: shouldRetrySessionsOnFailure,
      });
      throw err;
    } finally {
      if (tempDb && !tempDbClosed) {
        try {
          closeMemoryDatabase(tempDb);
        } catch {}
      }
      try {
        removeMemoryDatabaseFiles(tempDbPath);
      } catch (err) {
        log.warn(`failed to remove memory reindex shadow database: ${formatErrorMessage(err)}`);
      }
      try {
        reindexLock?.release();
      } catch (err) {
        log.warn(`failed to release memory reindex lock for ${dbPath}: ${formatErrorMessage(err)}`);
      }
    }
  }
}
