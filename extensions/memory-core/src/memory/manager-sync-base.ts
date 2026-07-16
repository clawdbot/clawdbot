// Memory Core plugin module owns shared manager synchronization state.
import type { DatabaseSync } from "node:sqlite";
import type { FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentDir,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemorySessionSyncTarget,
  type MemorySource,
  type MemorySyncParams,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import {
  resolveEmbeddingProviderAdapterId,
  resolveEmbeddingProviderFallbackModel,
  resolveEmbeddingProviderIndexIdentity,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import { openMemoryDatabaseAtPath } from "./manager-db.js";
import {
  resolveMemoryPrimaryProviderRequest,
  type MemoryProviderLifecycleState,
} from "./manager-provider-state.js";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  resolveMemoryIndexProviderIdentities,
  resolveMemoryIndexIdentityState,
  type MemoryIndexIdentityState,
  type MemoryIndexMeta,
  type MemoryIndexProviderIdentity,
} from "./manager-reindex-state.js";
import type { MemoryWatchSettleQueue } from "./watch-settle.js";

export type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

export type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  kind?: "markdown" | "multimodal";
  content?: string;
  contentText?: string;
  lineMap?: number[];
};

export type MemoryIndexWorkItem = {
  entry: MemoryIndexEntry;
  source: MemorySource;
  afterIndex?: () => void;
};

export type MemorySourceSyncPlan = {
  indexItems: MemoryIndexWorkItem[];
  finalize: () => Promise<void> | void;
};

type MemorySessionDeltaState = {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
};

type MemoryReindexRetryState = {
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
  sessionDeltas: Map<string, MemorySessionDeltaState>;
};

export const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";
const META_KEY = MEMORY_INDEX_META_KEY;
const VECTOR_TABLE = MEMORY_INDEX_VECTOR_TABLE;
const LEGACY_VECTOR_TABLE = "chunks_vec";
const EMBEDDING_CACHE_TABLE = MEMORY_EMBEDDING_CACHE_TABLE;
const EMBEDDING_CACHE_SEED_BATCH_SIZE = 1_000;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const log = createSubsystemLogger("memory");

function memoryTableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}
export abstract class MemoryManagerSyncBase {
  protected readonly acquireLocalService?: MemoryCoreAcquireLocalService;
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: EmbeddingProviderId;
  protected abstract providerUnavailableReason?: string;
  protected abstract providerLifecycle: MemoryProviderLifecycleState;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource> = new Set();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected fallbackReason?: string;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected memoryWatchPressureStartupTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  // Failed full memory reindexes must retry as full rebuilds, not incremental
  // dirty syncs that can skip unchanged files against the still-live index.
  protected memoryFullRetryDirty = false;
  protected pendingWatchPaths: MemoryWatchSettleQueue = new Map();
  protected sessionsDirty = false;
  // Failed full reindexes can start with no per-file dirty set. Keep a
  // one-shot all-sessions retry marker so the next non-force sync cannot skip.
  protected sessionsFullRetryDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionPendingTargets = new Map<string, MemorySessionSyncTarget>();
  protected sessionDeltas = new Map<string, MemorySessionDeltaState>();
  protected vectorDegradedWriteWarningShown = false;
  protected lastMetaSerialized: string | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract resolveProviderIndexIdentities(): MemoryIndexProviderIdentity[];
  protected abstract sync(params?: MemorySyncParams): Promise<void>;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract resetProviderInitializationForRetry(): void;
  protected abstract assertRequiredProviderAvailable(operation: "search" | "sync"): void;
  protected abstract indexFile(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;
  protected abstract syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
    deferIndex?: boolean;
  }): Promise<MemorySourceSyncPlan>;
  protected abstract syncArchiveFiles(params: {
    needsFullReindex: boolean;
    targetArchiveFiles?: string[];
    progress?: MemorySyncProgressState;
    deferIndex?: boolean;
    prefixIndexItems?: MemoryIndexWorkItem[];
  }): Promise<MemorySourceSyncPlan>;
  protected async indexFiles(items: MemoryIndexWorkItem[]): Promise<void> {
    for (const item of items) {
      await this.indexFile(item.entry, { source: item.source });
    }
  }

  protected emptySourceSyncPlan(): MemorySourceSyncPlan {
    return { indexItems: [], finalize: () => {} };
  }

  protected snapshotReindexRetryState(): MemoryReindexRetryState {
    return {
      dirty: this.dirty,
      memoryFullRetryDirty: this.memoryFullRetryDirty,
      sessionsDirty: this.sessionsDirty,
      sessionsFullRetryDirty: this.sessionsFullRetryDirty,
      sessionsDirtyFiles: new Set(this.sessionsDirtyFiles),
      sessionDeltas: new Map(
        Array.from(this.sessionDeltas, ([file, state]) => [file, { ...state }]),
      ),
    };
  }

  protected restoreReindexRetryState(snapshot: MemoryReindexRetryState): void {
    this.dirty = snapshot.dirty || this.dirty;
    this.memoryFullRetryDirty = snapshot.memoryFullRetryDirty || this.memoryFullRetryDirty;
    this.sessionsFullRetryDirty = snapshot.sessionsFullRetryDirty || this.sessionsFullRetryDirty;
    this.sessionsDirtyFiles = new Set([...snapshot.sessionsDirtyFiles, ...this.sessionsDirtyFiles]);
    const currentDeltas = this.sessionDeltas;
    this.sessionDeltas = new Map(
      Array.from(currentDeltas, ([file, state]) => [file, { ...state }]),
    );
    for (const [file, state] of snapshot.sessionDeltas) {
      this.sessionDeltas.set(file, { ...state });
    }
    this.sessionsDirty =
      snapshot.sessionsDirty ||
      this.sessionsDirty ||
      this.sessionsFullRetryDirty ||
      this.sessionsDirtyFiles.size > 0;
  }

  protected markFailedFullReindexRetry(params: { memory: boolean; sessions: boolean }): void {
    if (params.memory) {
      this.dirty = true;
      this.memoryFullRetryDirty = true;
    }
    if (params.sessions) {
      this.sessionsDirty = true;
      this.sessionsFullRetryDirty = true;
    }
  }

  protected clearSessionRetryState(): void {
    this.sessionsDirty = false;
    this.sessionsFullRetryDirty = false;
    this.sessionsDirtyFiles.clear();
  }

  protected clearMemoryRetryState(): void {
    this.dirty = false;
    this.memoryFullRetryDirty = false;
  }

  protected refreshSessionDirtyFlag(): void {
    this.sessionsDirty = this.sessionsFullRetryDirty || this.sessionsDirtyFiles.size > 0;
  }

  protected shouldDeferSourceWideBatch(): boolean {
    return Boolean(
      this.batch.enabled &&
      this.provider &&
      this.providerRuntime?.batchEmbed &&
      this.providerRuntime.sourceWideBatchEmbed === true,
    );
  }

  protected async indexQueuedFiles(
    items: MemoryIndexWorkItem[],
    progress?: MemorySyncProgressState,
    label?: string,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    if (progress && label) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label,
      });
    }
    await this.indexFiles(items);
    for (const item of items) {
      item.afterIndex?.();
    }
    if (progress) {
      progress.completed += items.length;
      progress.report({
        completed: progress.completed,
        total: progress.total,
      });
    }
  }

  protected async executeSourceSyncPlans(
    plans: MemorySourceSyncPlan[],
    progress?: MemorySyncProgressState,
  ): Promise<void> {
    const indexItems = plans.flatMap((plan) => plan.indexItems);
    const sources = new Set(indexItems.map((item) => item.source));
    await this.indexQueuedFiles(
      indexItems,
      progress,
      sources.size > 1 ? "Indexing memory sources (batch)..." : undefined,
    );
    for (const plan of plans) {
      await plan.finalize();
    }
  }

  protected async executeSourceWideSync(params: {
    shouldSyncMemory: boolean;
    shouldSyncSessions: boolean;
    needsFullReindex: boolean;
    needsFullSessionReindex?: boolean;
    targetArchiveFiles?: string[];
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const memoryPlan = params.shouldSyncMemory
      ? await this.syncMemoryFiles({
          needsFullReindex: params.needsFullReindex,
          progress: params.progress,
          deferIndex: true,
        })
      : this.emptySourceSyncPlan();
    if (params.shouldSyncSessions) {
      await this.syncArchiveFiles({
        needsFullReindex: params.needsFullSessionReindex ?? params.needsFullReindex,
        targetArchiveFiles: params.targetArchiveFiles,
        progress: params.progress,
        deferIndex: true,
        prefixIndexItems: memoryPlan.indexItems,
      });
      await memoryPlan.finalize();
      return;
    }
    await this.executeSourceSyncPlans([memoryPlan], params.progress);
  }

  protected hasIndexedChunks(): boolean {
    const row = this.db.prepare(`SELECT 1 as found FROM memory_index_chunks LIMIT 1`).get() as
      | { found?: number }
      | undefined;
    return row?.found === 1;
  }

  protected hasSemanticChunks(): boolean {
    const row = this.db
      .prepare(`SELECT 1 as found FROM memory_index_chunks WHERE model != 'fts-only' LIMIT 1`)
      .get() as { found?: number } | undefined;
    return row?.found === 1;
  }

  protected resolveCurrentIndexIdentityState(params?: {
    meta?: MemoryIndexMeta | null;
    provider?: { id: string; model: string } | null;
    providerKeyKnown?: boolean;
    vectorReady?: boolean;
    hasIndexedChunks?: boolean;
  }): MemoryIndexIdentityState {
    const hasProviderOverride = params && "provider" in params;
    const configuredIndexIdentity =
      !hasProviderOverride && !this.provider && this.settings.provider !== "none"
        ? resolveEmbeddingProviderIndexIdentity({
            config: this.cfg,
            agentDir: resolveAgentDir(this.cfg, this.agentId),
            ...resolveMemoryPrimaryProviderRequest({ settings: this.settings }),
          })
        : undefined;
    // Plain status can compare identity before provider init. Mirror provider
    // init's empty-model fallback so adapter defaults do not look mismatched.
    const configuredProvider =
      this.settings.provider === "none"
        ? null
        : (configuredIndexIdentity?.provider ?? {
            id:
              resolveEmbeddingProviderAdapterId(this.settings.provider, this.cfg) ??
              this.settings.provider,
            model:
              this.settings.model.trim() ||
              resolveEmbeddingProviderFallbackModel(this.settings.provider, "fts-only", this.cfg),
          });
    const provider = hasProviderOverride
      ? params.provider!
      : this.provider
        ? { id: this.provider.id, model: this.provider.model }
        : configuredProvider;
    const vectorReady =
      params && "vectorReady" in params
        ? Boolean(params.vectorReady)
        : this.vector.available === true;
    const initializedProviderIdentities =
      provider &&
      this.provider &&
      provider.id === this.provider.id &&
      provider.model === this.provider.model
        ? this.resolveProviderIndexIdentities()
        : [];
    const configuredProviderIdentities = configuredIndexIdentity
      ? resolveMemoryIndexProviderIdentities({
          provider: configuredIndexIdentity.provider,
          cacheKeyData: configuredIndexIdentity.cacheKeyData,
          aliases: configuredIndexIdentity.aliases,
        })
      : [];
    const providerIdentities =
      initializedProviderIdentities.length > 0
        ? initializedProviderIdentities
        : configuredProviderIdentities;
    const configuredProviderKeyKnown = configuredProviderIdentities.length > 0;
    return resolveMemoryIndexIdentityState({
      meta: params && "meta" in params ? params.meta! : this.readMeta(),
      provider,
      providerKey: configuredProviderKeyKnown
        ? providerIdentities[0]?.providerKey
        : params?.providerKeyKnown === false
          ? undefined
          : (this.providerKey ?? undefined),
      providerAliases: providerIdentities.slice(1),
      providerKeyKnown: configuredProviderKeyKnown ? true : params?.providerKeyKnown,
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
      hasIndexedChunks:
        params && "hasIndexedChunks" in params
          ? Boolean(params.hasIndexedChunks)
          : this.hasIndexedChunks(),
      ftsTokenizer: this.settings.store.fts.tokenizer,
    });
  }

  protected resetVectorState(): void {
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.semanticAvailable = undefined;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.vectorDegradedWriteWarningShown = false;
  }

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready;
    try {
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      // Another process may have published a vectorless index while this
      // connection retained the previous dimensions in memory.
      const persistedMeta = this.readMeta();
      if (persistedMeta && persistedMeta.vectorDims !== this.vector.dims) {
        this.vector.dims = persistedMeta.vectorDims;
      }
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      if (this.dropLegacyVectorTable()) {
        // A broad dirty sync can skip unchanged files whose source hashes were
        // migrated. Force the next sync to republish the derived vector rows.
        this.dirty = true;
        this.memoryFullRetryDirty = true;
      }
      return true;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions && memoryTableExists(this.db, VECTOR_TABLE)) {
      return;
    }
    if (!this.dropVectorTable()) {
      throw new Error(`Failed to reset ${VECTOR_TABLE} before rebuilding vector dimensions`);
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropLegacyVectorTable(): boolean {
    if (!memoryTableExists(this.db, LEGACY_VECTOR_TABLE)) {
      return false;
    }
    try {
      this.db.exec(`DROP TABLE ${LEGACY_VECTOR_TABLE}`);
      return true;
    } catch (err) {
      log.debug(`Failed to drop ${LEGACY_VECTOR_TABLE}: ${formatErrorMessage(err)}`);
      return false;
    }
  }

  private dropVectorTable(): boolean {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
      return true;
    } catch (err) {
      const message = formatErrorMessage(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
      return false;
    }
  }

  protected buildSourceFilter(
    alias?: string,
    sourcesOverride?: MemorySource[],
  ): { sql: string; params: MemorySource[] } {
    const sources = sourcesOverride ?? Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.databasePath);
    return openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled, this.agentId);
  }

  protected async seedEmbeddingCache(sourceDb: DatabaseSync): Promise<void> {
    if (!this.cache.enabled) {
      return;
    }
    type CacheRow = {
      rowid: number;
      provider: string;
      model: string;
      provider_key: string;
      hash: string;
      embedding: string;
      dims: number | null;
      updated_at: number;
    };
    const selectBatch = sourceDb.prepare(
      `SELECT rowid, provider, model, provider_key, hash, embedding, dims, updated_at
       FROM ${EMBEDDING_CACHE_TABLE}
       WHERE rowid > ?
       ORDER BY rowid
       LIMIT ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
         embedding=excluded.embedding,
         dims=excluded.dims,
         updated_at=excluded.updated_at`,
    );
    let lastRowid = 0;
    while (true) {
      // Materialize each source page so neither a read cursor nor a write
      // transaction remains open when control returns to the event loop.
      const batch = selectBatch.all(lastRowid, EMBEDDING_CACHE_SEED_BATCH_SIZE) as CacheRow[];
      if (batch.length === 0) {
        return;
      }
      runSqliteImmediateTransactionSync(
        this.db,
        () => {
          for (const row of batch) {
            insert.run(
              row.provider,
              row.model,
              row.provider_key,
              row.hash,
              row.embedding,
              row.dims,
              row.updated_at,
            );
          }
        },
        { operationLabel: "memory.embedding-cache.seed" },
      );
      lastRowid = batch[batch.length - 1]?.rowid ?? lastRowid;
      if (batch.length < EMBEDDING_CACHE_SEED_BATCH_SIZE) {
        return;
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      cacheEnabled: this.cache.enabled,
      ftsEnabled: this.fts.enabled,
      ftsTokenizer: this.settings.store.fts.tokenizer,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db
      .prepare(`SELECT value FROM memory_index_meta WHERE key = ?`)
      .get(META_KEY) as { value: string } | undefined;
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch {
      this.lastMetaSerialized = null;
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO memory_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
    this.lastMetaSerialized = value;
  }
}
