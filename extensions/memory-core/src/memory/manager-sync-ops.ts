// Memory Core plugin module implements manager sync ops behavior.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  onInternalSessionTranscriptUpdate,
  resolveAgentDir,
  resolveSessionTranscriptsDirForAgent,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  parseSqliteSessionFileMarker,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionFileForSyncTarget,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  buildFileEntry,
  ensureMemoryIndexSchema,
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  normalizeExtraMemoryPaths,
  retryTransientMemoryRead,
  runWithConcurrency,
  type MemorySource,
  type MemorySessionSyncTarget,
  type MemorySyncParams,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import {
  createEmbeddingProvider,
  resolveEmbeddingProviderAdapterId,
  resolveEmbeddingProviderFallbackModel,
  resolveEmbeddingProviderIndexIdentity,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
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
  resolveMemoryFallbackProviderRequest,
  resolveFallbackCurrentProviderId,
  resolveMemoryPrimaryProviderRequest,
  type MemoryProviderLifecycleState,
} from "./manager-provider-state.js";
import { acquireMemoryReindexLock, type MemoryReindexLockHandle } from "./manager-reindex-lock.js";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  resolveMemoryIndexProviderIdentities,
  resolveMemoryIndexIdentityState,
  type MemoryIndexIdentityState,
  type MemoryIndexMeta,
  type MemoryIndexProviderIdentity,
} from "./manager-reindex-state.js";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";
import {
  resolveMemorySessionStartupDirtyFiles,
  resolveMemorySessionSyncPlan,
  type MemorySessionStartupFileState,
} from "./manager-session-sync-state.js";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";
import {
  markMemoryTargetArchiveFilesDirty,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";
import {
  countChokidarWatchedEntries,
  type MemoryWatchPressureUnit,
  type MemoryWatchPressureWarningState,
  warnIfMemoryWatchPressureHigh,
} from "./watch-pressure.js";
import {
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchEventStats,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

type MemorySyncProgressState = {
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

type MemorySourceSyncPlan = {
  indexItems: MemoryIndexWorkItem[];
  finalize: () => Promise<void> | void;
};

type MemorySessionDeltaState = { lastSize: number; pendingBytes: number; pendingMessages: number };

type MemoryReindexRetryState = {
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
  sessionDeltas: Map<string, MemorySessionDeltaState>;
};

function sessionPathForCorpusEntry(entry: SessionTranscriptCorpusEntry): string {
  return entry.transcriptSource === "sqlite"
    ? sessionPathForSessionIdentity(entry.agentId, entry.sessionId)
    : sessionPathForFile(entry.sessionFile);
}

function legacyExtensionlessSessionPathForIdentity(agentId: string, sessionId: string): string {
  return path.join("sessions", normalizeAgentId(agentId), sessionId).replace(/\\/g, "/");
}

function buildSessionEntryOptions(entry: SessionTranscriptCorpusEntry) {
  return {
    generatedByDreamingNarrative: entry.generatedByDreamingNarrative === true,
    generatedByCronRun: entry.generatedByCronRun === true,
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
  };
}

const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE = MEMORY_INDEX_VECTOR_TABLE;
const LEGACY_VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const EMBEDDING_CACHE_TABLE = MEMORY_EMBEDDING_CACHE_TABLE;
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const SESSION_SYNC_YIELD_EVERY = 10;
const SOURCE_WIDE_SESSION_INDEX_FLUSH_FILES = 128;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS = 10_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

type MemorySessionTranscriptUpdate = {
  agentId?: string;
  sessionFile?: string;
  sessionKey?: string;
  target?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
  };
};

function memoryTableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

type NativeMemoryWatchPair = {
  dir: string;
  main: fsSync.FSWatcher;
  parent: fsSync.FSWatcher | null;
  treeWatchers?: Map<string, LinuxMemoryDirectoryWatcher>;
};

type LinuxMemoryDirectoryWatcher = {
  watcher: fsSync.FSWatcher;
  ino: number;
};

function resolveMemoryWatchFactory(): typeof chokidar.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[TEST_MEMORY_WATCH_FACTORY_KEY];
    if (typeof override === "function") {
      return override as typeof chokidar.watch;
    }
  }
  return chokidar.watch.bind(chokidar);
}

function resolveMemoryNativeWatchFactory(): typeof fsSync.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[
      TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY
    ];
    if (typeof override === "function") {
      return override as typeof fsSync.watch;
    }
  }
  return fsSync.watch.bind(fsSync);
}

function shouldIgnoreMemoryWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
  multimodalSettings?: ResolvedMemorySearchConfig["multimodal"],
): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  if (parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const extension = normalizeLowercaseStringOrEmpty(path.extname(normalized));
  if (extension.length === 0 || extension === ".md") {
    return false;
  }
  if (!multimodalSettings) {
    return true;
  }
  return classifyMemoryMultimodalPath(normalized, multimodalSettings) === null;
}

export function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err: unknown) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

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

export abstract class MemoryManagerSyncOps {
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
  private nativeMemoryWatchPairs: NativeMemoryWatchPair[] = [];
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
  private readonly memoryWatchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionPendingTargets = new Map<string, MemorySessionSyncTarget>();
  protected sessionDeltas = new Map<string, MemorySessionDeltaState>();
  protected vectorDegradedWriteWarningShown = false;
  private lastMetaSerialized: string | null = null;

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
  protected async indexFiles(items: MemoryIndexWorkItem[]): Promise<void> {
    for (const item of items) {
      await this.indexFile(item.entry, { source: item.source });
    }
  }

  private emptySourceSyncPlan(): MemorySourceSyncPlan {
    return { indexItems: [], finalize: () => {} };
  }

  private snapshotReindexRetryState(): MemoryReindexRetryState {
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

  private restoreReindexRetryState(snapshot: MemoryReindexRetryState): void {
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

  private markFailedFullReindexRetry(params: { memory: boolean; sessions: boolean }): void {
    if (params.memory) {
      this.dirty = true;
      this.memoryFullRetryDirty = true;
    }
    if (params.sessions) {
      this.sessionsDirty = true;
      this.sessionsFullRetryDirty = true;
    }
  }

  private clearSessionRetryState(): void {
    this.sessionsDirty = false;
    this.sessionsFullRetryDirty = false;
    this.sessionsDirtyFiles.clear();
  }

  private clearMemoryRetryState(): void {
    this.dirty = false;
    this.memoryFullRetryDirty = false;
  }

  private refreshSessionDirtyFlag(): void {
    this.sessionsDirty = this.sessionsFullRetryDirty || this.sessionsDirtyFiles.size > 0;
  }

  private shouldDeferSourceWideBatch(): boolean {
    return Boolean(
      this.batch.enabled &&
      this.provider &&
      this.providerRuntime?.batchEmbed &&
      this.providerRuntime.sourceWideBatchEmbed === true,
    );
  }

  private async indexQueuedFiles(
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

  private async executeSourceSyncPlans(
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

  private async executeSourceWideSync(params: {
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

  private async seedEmbeddingCache(sourceDb: DatabaseSync): Promise<void> {
    if (!this.cache.enabled) {
      return;
    }
    let transactionStarted = false;
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .iterate() as IterableIterator<{
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }>;
      let rowCount = 0;
      let insert: ReturnType<DatabaseSync["prepare"]> | null = null;
      for (const row of rows) {
        if (!insert) {
          insert = this.db.prepare(
            `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
               embedding=excluded.embedding,
               dims=excluded.dims,
               updated_at=excluded.updated_at`,
          );
          this.db.exec("BEGIN");
          transactionStarted = true;
        }
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
        rowCount += 1;
        if (rowCount % 1000 === 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      if (transactionStarted) {
        this.db.exec("COMMIT");
      }
    } catch (err) {
      if (transactionStarted) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
      }
      throw err;
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

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watcher || this.nativeMemoryWatchPairs.length > 0) {
      // Already initialized — preserve idempotence.
      return;
    }
    // Core paths preserve original symlink-follow behavior (chokidar/fs.watch
    // resolve through symlinks by default); extraPaths preserves the original
    // explicit symlink-skip policy.
    const fileWatchPaths = new Set<string>([path.join(this.workspaceDir, "MEMORY.md")]);
    const dirWatchPaths = new Set<string>([path.join(this.workspaceDir, "memory")]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          dirWatchPaths.add(entry);
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)
        ) {
          fileWatchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
      this.dirty = true;
      this.scheduleWatchSync();
    };
    // Native recursive fs.watch for directory paths — one watcher per
    // directory on macOS (FSEvents) and Windows (ReadDirectoryChangesW).
    // Avoids chokidar's per-file fs.watch fan-out on large memory trees.
    //
    // Linux is intentionally handled by a separate directory-tree watcher
    // below: Node's `fs.watch(dir, { recursive: true })` routes through
    // `internal/fs/recursive_watch` and watches every file. Watching
    // directories only preserves Linux inotify semantics while avoiding
    // per-file watch descriptor fan-out.
    //
    // On any other native creation failure (e.g. unsupported filesystem,
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM) the directory also falls back to
    // chokidar so freshness is preserved on the degraded path.
    const nativeRecursiveSupported = process.platform === "darwin" || process.platform === "win32";
    for (const dir of dirWatchPaths) {
      const attached = nativeRecursiveSupported
        ? this.attachNativeMemoryWatchForDir(dir, markDirty)
        : process.platform === "linux"
          ? this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty)
          : false;
      if (!attached) {
        // Native creation failed (dir missing, unsupported FS, throw) —
        // fall back to chokidar so directory coverage isn't dropped.
        fileWatchPaths.add(dir);
      }
    }
    if (fileWatchPaths.size > 0) {
      const existingWatcher = this.currentMemoryChokidarWatcher();
      if (existingWatcher) {
        existingWatcher.add(Array.from(fileWatchPaths));
      } else {
        const watcher = resolveMemoryWatchFactory()(Array.from(fileWatchPaths), {
          ignoreInitial: true,
          ignored: (watchPath, stats) =>
            shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
        });
        this.watcher = watcher;
        watcher.on("add", markDirty);
        watcher.on("change", markDirty);
        watcher.on("unlink", markDirty);
        watcher.on("unlinkDir", markDirty);
        watcher.on("error", (err) => {
          // File watcher errors (e.g., ENOSPC) should not crash the gateway.
          // Log the error and continue - memory search still works without auto-sync.
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`memory watcher error: ${message}`);
        });
        watcher.once("ready", () => {
          this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(watcher), "paths");
        });
      }
    }
    this.scheduleMemoryWatchPressureStartupCheck();
  }

  private scheduleMemoryWatchPressureStartupCheck(): void {
    if (
      this.memoryWatchPressureStartupTimer ||
      this.memoryWatchPressureWarning.shown ||
      this.closed ||
      (this.nativeMemoryWatchPairs.length === 0 && !this.watcher)
    ) {
      return;
    }
    this.memoryWatchPressureStartupTimer = setTimeout(() => {
      this.memoryWatchPressureStartupTimer = null;
      if (this.closed || this.memoryWatchPressureWarning.shown) {
        return;
      }
      if (this.watcher) {
        this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(this.watcher), "paths");
      }
      if (this.memoryWatchPressureWarning.shown) {
        return;
      }
      let directoryCount = 0;
      for (const pair of this.nativeMemoryWatchPairs) {
        directoryCount += pair.treeWatchers?.size ?? 0;
      }
      this.warnIfMemoryWatchPressure(directoryCount, "directories");
    }, MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS);
  }

  private warnIfMemoryWatchPressure(count: number, unit: MemoryWatchPressureUnit): void {
    warnIfMemoryWatchPressureHigh(
      this.memoryWatchPressureWarning,
      count,
      unit,
      "Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files.",
      "Remove large extraPaths, or set memorySearch.sync.watch to false and refresh memory manually or with sync.intervalMinutes.",
      (message) => log.warn(message),
    );
  }

  private currentMemoryChokidarWatcher(): FSWatcher | null {
    return this.watcher;
  }

  // Attach a native recursive `fs.watch` to `dir` plus a non-recursive
  // parent-directory watch that detects root-replacement
  // (`rm -rf memory && mkdir memory`) by inode comparison. Returns true if
  // the main native watcher attached. Called from ensureWatcher(); also
  // re-entered from the parent-watch handler on detected replacement.
  protected attachNativeMemoryWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): boolean {
    if (this.closed) {
      return false;
    }
    let recordedInode: number | null;
    try {
      recordedInode = fsSync.statSync(dir).ino;
    } catch {
      // Dir doesn't exist; caller will fall back to chokidar.
      return false;
    }
    let mainWatcher: fsSync.FSWatcher;
    try {
      mainWatcher = resolveMemoryNativeWatchFactory()(
        dir,
        { recursive: true },
        (_eventType, filename) => {
          if (filename == null) {
            // Node docs: filename may be null on some platforms even when
            // recursive watching is otherwise supported. Be conservative
            // and mark broadly dirty rather than dropping the event.
            markDirty();
            return;
          }
          const full = path.join(dir, filename);
          let stats: fsSync.Stats | undefined;
          try {
            const s = fsSync.lstatSync(full, { throwIfNoEntry: false });
            stats = s ?? undefined;
          } catch {
            stats = undefined;
          }
          if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
            return;
          }
          // Pass stats so the watch-settle queue can debounce rapid
          // writes; without a snapshot the queue cannot detect stability.
          markDirty(full, stats);
        },
      );
    } catch (err) {
      log.warn(
        `failed to start native recursive watcher on ${dir}: ${String(err)}; falling back to chokidar`,
      );
      return false;
    }
    const pair: NativeMemoryWatchPair = { dir, main: mainWatcher, parent: null };
    mainWatcher.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory native watcher error on ${dir}: ${message}`);
      // Per Node docs the FSWatcher is no longer usable after an error.
      this.closeNativeMemoryWatchPair(pair);
      if (this.closed) {
        return;
      }
      // Force a broad re-sync to cover the gap, then restore directory
      // coverage by reattaching to chokidar so subsequent file changes
      // still drive watch sync (intervalMinutes defaults to 0; without
      // a watcher the directory would stop being indexed).
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
    });
    this.nativeMemoryWatchPairs.push(pair);
    // Non-recursive parent watcher: catches root-directory replacement so
    // we can reattach the main watcher on the new inode. Without this,
    // `rm -rf memory && mkdir memory` would leave the main watcher bound
    // to the dead inode and silently miss subsequent file changes.
    try {
      const parentDir = path.dirname(dir);
      const baseName = path.basename(dir);
      const parentWatcher = resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          // Per Node docs `filename` can be null on some platforms even
          // when the parent watcher is otherwise supported. Treat null
          // as an unknown event and re-check the watched directory's inode;
          // otherwise filter by basename so sibling events don't trigger reattach.
          if (filename !== null && filename !== baseName) {
            return;
          }
          let currentInode: number | null;
          try {
            currentInode = fsSync.statSync(dir).ino;
          } catch {
            currentInode = null;
          }
          if (currentInode === recordedInode) {
            return;
          }
          // Root was replaced (or removed). Tear down the existing pair
          // and either reattach (if dir still exists) or fall back to
          // chokidar (if dir is gone).
          this.closeNativeMemoryWatchPair(pair);
          if (this.closed) {
            return;
          }
          markDirty();
          if (currentInode !== null) {
            // Re-attach on the new inode (this also installs a fresh
            // parent watcher closed over the new recordedInode). If the
            // helper's own statSync races with the dir disappearing
            // between our inode check and its own check, it returns
            // false — fall back to chokidar so coverage isn't lost.
            if (!this.attachNativeMemoryWatchForDir(dir, markDirty)) {
              this.attachMemoryChokidarFallback(dir, markDirty);
            }
          } else {
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        },
      );
      parentWatcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory native parent watcher error on ${path.dirname(dir)}: ${message}`);
        try {
          parentWatcher.close();
        } catch {
          // ignore
        }
        this.removeNativeMemoryParentWatch(parentWatcher);
        if (pair.parent === parentWatcher) {
          pair.parent = null;
        }
        // Main watcher still alive — root-replacement detection is lost
        // but normal events still flow. No fallback needed.
      });
      pair.parent = parentWatcher;
    } catch (err) {
      // Parent watcher couldn't start (e.g. parentDir not accessible).
      // The main watcher still works for non-replacement events; just
      // log and continue.
      log.warn(
        `memory native parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
    return true;
  }

  // Linux inotify reports direct child changes from a watched directory, but
  // it has no native recursive primitive. Watch directories only, then attach
  // newly-created subdirectories on demand; this avoids per-file watchers.
  protected attachLinuxMemoryDirectoryTreeWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): boolean {
    if (this.closed) {
      return false;
    }
    let recordedInode: number | null;
    try {
      recordedInode = fsSync.statSync(dir).ino;
    } catch {
      return false;
    }

    let pair: NativeMemoryWatchPair | null = null;
    const treeWatchers = new Map<string, LinuxMemoryDirectoryWatcher>();

    const closeAndFallback = (message: string) => {
      log.warn(message);
      if (pair) {
        this.closeNativeMemoryWatchPair(pair);
      }
      if (this.closed) {
        return;
      }
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
    };

    const closeDirectorySubtree = (watchDir: string) => {
      const watchDirPrefix = `${watchDir}${path.sep}`;
      for (const [entryDir, entry] of Array.from(treeWatchers.entries())) {
        if (entryDir !== watchDir && !entryDir.startsWith(watchDirPrefix)) {
          continue;
        }
        try {
          entry.watcher.close();
        } catch {
          // ignore close failures
        }
        treeWatchers.delete(entryDir);
      }
    };

    const attachDirectory = (watchDir: string): fsSync.FSWatcher | null => {
      if (this.closed) {
        return null;
      }
      let currentInode: number;
      try {
        const currentStat = fsSync.statSync(watchDir);
        if (!currentStat.isDirectory()) {
          return null;
        }
        currentInode = currentStat.ino;
      } catch {
        return null;
      }
      const existing = treeWatchers.get(watchDir);
      if (existing) {
        if (existing.ino === currentInode) {
          return existing.watcher;
        }
        closeDirectorySubtree(watchDir);
      }
      let watcher: fsSync.FSWatcher;
      try {
        watcher = resolveMemoryNativeWatchFactory()(
          watchDir,
          { recursive: false },
          (eventType, filename) => {
            if (filename == null) {
              markDirty();
              if (!this.attachLinuxMemoryDirectoryTreeSubtree(watchDir, attachDirectory)) {
                closeAndFallback(
                  `failed to refresh Linux memory directory watchers under ${watchDir}; falling back to chokidar`,
                );
              }
              return;
            }
            const full = path.join(watchDir, filename);
            let stats: fsSync.Stats | undefined;
            try {
              const s = fsSync.lstatSync(full, { throwIfNoEntry: false });
              stats = s ?? undefined;
            } catch {
              stats = undefined;
            }
            if (!stats) {
              closeDirectorySubtree(full);
            }
            if (stats?.isDirectory()) {
              if (eventType === "rename") {
                closeDirectorySubtree(full);
              }
              if (!this.attachLinuxMemoryDirectoryTreeSubtree(full, attachDirectory)) {
                closeAndFallback(
                  `failed to attach Linux memory directory watcher under ${full}; falling back to chokidar`,
                );
                return;
              }
            }
            if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
              return;
            }
            markDirty(full, stats);
          },
        );
      } catch (err) {
        if (watchDir === dir) {
          log.warn(
            `failed to start Linux memory directory watcher on ${watchDir}: ${String(err)}; falling back to chokidar`,
          );
        }
        return null;
      }
      treeWatchers.set(watchDir, { watcher, ino: currentInode });
      watcher.on("error", (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        closeAndFallback(`memory Linux directory watcher error on ${watchDir}: ${detail}`);
      });
      return watcher;
    };

    const mainWatcher = attachDirectory(dir);
    if (!mainWatcher) {
      return false;
    }
    pair = { dir, main: mainWatcher, parent: null, treeWatchers };
    this.nativeMemoryWatchPairs.push(pair);
    if (!this.attachLinuxMemoryDirectoryTreeSubtree(dir, attachDirectory)) {
      closeAndFallback(
        `failed to attach Linux memory directory watcher subtree under ${dir}; falling back to chokidar`,
      );
      return true;
    }

    try {
      const parentDir = path.dirname(dir);
      const baseName = path.basename(dir);
      const parentWatcher = resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          if (filename !== null && filename !== baseName) {
            return;
          }
          let currentInode: number | null;
          try {
            currentInode = fsSync.statSync(dir).ino;
          } catch {
            currentInode = null;
          }
          if (currentInode === recordedInode) {
            return;
          }
          this.closeNativeMemoryWatchPair(pair);
          if (this.closed) {
            return;
          }
          markDirty();
          if (currentInode !== null) {
            if (!this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty)) {
              this.attachMemoryChokidarFallback(dir, markDirty);
            }
          } else {
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        },
      );
      parentWatcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory Linux parent watcher error on ${path.dirname(dir)}: ${message}`);
        try {
          parentWatcher.close();
        } catch {
          // ignore
        }
        this.removeNativeMemoryParentWatch(parentWatcher);
        if (pair?.parent === parentWatcher) {
          pair.parent = null;
        }
      });
      pair.parent = parentWatcher;
    } catch (err) {
      log.warn(
        `memory Linux parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
    return true;
  }

  private attachLinuxMemoryDirectoryTreeSubtree(
    root: string,
    attachDirectory: (dir: string) => fsSync.FSWatcher | null,
  ): boolean {
    let rootStats: fsSync.Stats | undefined;
    try {
      rootStats = fsSync.lstatSync(root, { throwIfNoEntry: false }) ?? undefined;
    } catch {
      return false;
    }
    if (
      !rootStats?.isDirectory() ||
      shouldIgnoreMemoryWatchPath(root, rootStats, this.settings.multimodal)
    ) {
      return true;
    }
    if (!attachDirectory(root)) {
      return false;
    }
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (
        !this.attachLinuxMemoryDirectoryTreeSubtree(path.join(root, entry.name), attachDirectory)
      ) {
        return false;
      }
    }
    return true;
  }

  private closeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    if (pair.treeWatchers) {
      for (const entry of pair.treeWatchers.values()) {
        try {
          entry.watcher.close();
        } catch {
          // ignore close failures
        }
      }
      pair.treeWatchers.clear();
    } else {
      try {
        pair.main.close();
      } catch {
        // ignore close failures
      }
    }
    if (pair.parent) {
      try {
        pair.parent.close();
      } catch {
        // ignore close failures
      }
      pair.parent = null;
    }
    this.removeNativeMemoryWatchPair(pair);
  }

  protected closeNativeMemoryWatchPairs(): void {
    while (this.nativeMemoryWatchPairs.length > 0) {
      const pair = this.nativeMemoryWatchPairs[0];
      if (!pair) {
        return;
      }
      this.closeNativeMemoryWatchPair(pair);
    }
  }

  private removeNativeMemoryParentWatch(w: fsSync.FSWatcher): void {
    for (const pair of this.nativeMemoryWatchPairs) {
      if (pair.parent === w) {
        pair.parent = null;
        return;
      }
    }
  }

  private removeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    const idx = this.nativeMemoryWatchPairs.indexOf(pair);
    if (idx >= 0) {
      this.nativeMemoryWatchPairs.splice(idx, 1);
    }
  }

  // Reattach `dir` to chokidar after a native recursive watcher dies, so
  // subsequent memory changes under `dir` continue to drive watch sync.
  // Called from the native watcher `error` handler in ensureWatcher();
  // factored out so the fallback shape can be unit-tested in isolation.
  protected attachMemoryChokidarFallback(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    if (this.closed) {
      // Manager teardown started — don't create new watcher resources.
      return;
    }
    try {
      if (this.watcher) {
        // Existing chokidar watcher (handling MEMORY.md and/or other file
        // paths) — extend it to cover this directory too.
        this.watcher.add(dir);
        return;
      }
      // No chokidar watcher exists yet. Spin one up just for this directory
      // so the periodic-sync gap is closed.
      const watcher = resolveMemoryWatchFactory()([dir], {
        ignoreInitial: true,
        ignored: (watchPath, stats) =>
          shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
      });
      this.watcher = watcher;
      watcher.on("add", markDirty);
      watcher.on("change", markDirty);
      watcher.on("unlink", markDirty);
      watcher.on("unlinkDir", markDirty);
      watcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory watcher error: ${message}`);
      });
      watcher.once("ready", () => {
        this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(watcher), "paths");
      });
    } catch (err) {
      log.warn(`failed to attach chokidar fallback for ${dir}: ${String(err)}`);
    }
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = this.subscribeSessionTranscriptUpdates((update) => {
      if (this.closed) {
        return;
      }
      const sessionFile = update.sessionFile;
      if (sessionFile && isSessionArchiveArtifactName(path.basename(sessionFile))) {
        return;
      }
      if (sessionFile && this.isSessionFileForAgent(sessionFile)) {
        this.scheduleSessionDirty(sessionFile);
        return;
      }
      const target = this.resolveSessionTranscriptUpdateSyncTarget(update);
      if (target) {
        this.scheduleSessionDirty(target);
        return;
      }
      if (sessionFile) {
        void this.scheduleCorpusSessionFileDirty(sessionFile).catch((err: unknown) => {
          log.warn(`memory session corpus update failed: ${String(err)}`);
        });
      }
    });
  }

  protected subscribeSessionTranscriptUpdates(
    listener: (update: MemorySessionTranscriptUpdate) => void,
  ): () => void {
    return onInternalSessionTranscriptUpdate(listener);
  }

  private async scheduleCorpusSessionFileDirty(sessionFile: string): Promise<void> {
    const resolvedSessionFile = path.resolve(sessionFile);
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    if (corpusEntries.some((entry) => path.resolve(entry.sessionFile) === resolvedSessionFile)) {
      this.scheduleSessionDirty(resolvedSessionFile);
    }
  }

  protected ensureSessionStartupCatchup(): void {
    if (!this.sources.has("sessions")) {
      return;
    }
    void this.runSessionStartupCatchup().catch((err: unknown) => {
      log.warn("memory session startup catch-up failed: " + String(err));
    });
  }

  protected async markSessionStartupCatchupDirtyFiles(): Promise<string[]> {
    if (!this.sources.has("sessions") || this.closed) {
      return [];
    }
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    if (corpusEntries.length === 0 || this.closed) {
      return [];
    }
    const existingRows = loadMemorySourceFileState({
      db: this.db,
      source: "sessions",
    }).rows;
    const fileStates = (
      await runWithConcurrency(
        corpusEntries.map(
          (corpusEntry) => async (): Promise<MemorySessionStartupFileState | null> => {
            if (corpusEntry.transcriptSource === "sqlite") {
              return statSessionEntrySync(
                corpusEntry.sessionFile,
                buildSessionEntryOptions(corpusEntry),
              );
            }
            const file = corpusEntry.sessionFile;
            try {
              const stat = await fs.stat(file);
              if (!stat.isFile()) {
                return null;
              }
              return {
                absPath: file,
                path: sessionPathForCorpusEntry(corpusEntry),
                mtimeMs: stat.mtimeMs,
                size: stat.size,
              };
            } catch (err) {
              if (isFileMissingError(err)) {
                return null;
              }
              throw err;
            }
          },
        ),
        this.getIndexConcurrency(),
      )
    ).filter((file): file is MemorySessionStartupFileState => file !== null);
    const dirtyFiles = resolveMemorySessionStartupDirtyFiles({ files: fileStates, existingRows });
    if (dirtyFiles.length === 0 || this.closed) {
      return dirtyFiles;
    }
    for (const file of dirtyFiles) {
      this.sessionsDirtyFiles.add(file);
    }
    this.sessionsDirty = true;
    return dirtyFiles;
  }

  protected async runSessionStartupCatchup(): Promise<string[]> {
    const dirtyFiles = await this.markSessionStartupCatchupDirtyFiles();
    if (dirtyFiles.length === 0 || this.closed) {
      return dirtyFiles;
    }
    void this.sync({ reason: "session-startup-catchup" }).catch((err: unknown) => {
      log.warn("memory sync failed (session-startup-catchup): " + String(err));
    });
    return dirtyFiles;
  }

  private scheduleSessionDirty(target: string | MemorySessionSyncTarget) {
    if (typeof target === "string") {
      this.sessionPendingFiles.add(target);
    } else {
      this.sessionPendingTargets.set(this.memorySessionSyncTargetKey(target), target);
    }
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err: unknown) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0 && this.sessionPendingTargets.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles);
    const pendingTargets = Array.from(this.sessionPendingTargets.values());
    this.sessionPendingFiles.clear();
    this.sessionPendingTargets.clear();
    pending.push(...Array.from(await this.resolveArchiveFilesForSyncTargets(pendingTargets)));
    let shouldSync = false;
    for (const sessionFile of pending) {
      if (!path.isAbsolute(sessionFile)) {
        this.sessionsDirtyFiles.add(sessionFile);
        this.sessionsDirty = true;
        shouldSync = true;
        continue;
      }
      // Usage-counted session archives (`.jsonl.reset.<iso>` and
      // `.jsonl.deleted.<iso>`) are one-shot mutation events: the file is
      // written once by the archive rotation and then never touched again.
      // They carry no incremental `append` semantics, so the delta-bytes /
      // delta-messages thresholds (designed for live transcripts accumulating
      // appended messages) cannot gate them correctly — a short archive
      // below the threshold would simply never reindex. Mark them dirty
      // directly and skip the delta accounting.
      const baseName = path.basename(sessionFile);
      if (
        isSessionArchiveArtifactName(baseName) &&
        isUsageCountedSessionTranscriptFileName(baseName)
      ) {
        this.sessionsDirtyFiles.add(sessionFile);
        this.sessionsDirty = true;
        shouldSync = true;
        continue;
      }
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err: unknown) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const size = stat.size;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await retryTransientMemoryRead(
        () => fs.open(absPath, "r"),
        `open session transcript for newline count ${absPath}`,
      );
    } catch (err) {
      if (isFileMissingError(err)) {
        return 0;
      }
      throw err;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await retryTransientMemoryRead(
          () => handle.read(buffer, 0, toRead, offset),
          `count session transcript newlines ${absPath}`,
        );
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private resolveSessionTranscriptUpdateSyncTarget(
    update: MemorySessionTranscriptUpdate,
  ): MemorySessionSyncTarget | null {
    if (update.sessionFile && isSessionArchiveArtifactName(path.basename(update.sessionFile))) {
      return null;
    }
    if (update.target) {
      const agentId = update.target.agentId.trim();
      const sessionId = update.target.sessionId.trim();
      const sessionKey = update.target.sessionKey.trim();
      if (!agentId || !sessionId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
        return null;
      }
      return {
        agentId,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
      };
    }
    if (!update.sessionFile) {
      return null;
    }
    const parsed = parseCanonicalSessionSyncTargetFromPath(update.sessionFile);
    if (!parsed) {
      return null;
    }
    const agentId = update.agentId?.trim() || parsed.agentId;
    if (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
      return null;
    }
    const sessionKey = update.sessionKey?.trim();
    return {
      agentId,
      sessionId: parsed.sessionId,
      ...(sessionKey ? { sessionKey } : {}),
    };
  }

  private normalizeTargetArchiveFiles(
    archiveFiles?: string[],
    corpusEntries: readonly SessionTranscriptCorpusEntry[] = [],
  ): Set<string> | null {
    if (!archiveFiles || archiveFiles.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    const corpusMarkers = new Set(
      corpusEntries
        .filter((entry) => entry.transcriptSource === "sqlite")
        .map((entry) => entry.sessionFile),
    );
    const corpusPaths = new Set(
      corpusEntries
        .filter((entry) => entry.transcriptSource !== "sqlite")
        .map((entry) => path.resolve(entry.sessionFile)),
    );
    for (const sessionFile of archiveFiles) {
      const trimmed = sessionFile.trim();
      if (!trimmed) {
        continue;
      }
      if (corpusMarkers.has(trimmed)) {
        normalized.add(trimmed);
        continue;
      }
      const sqliteMarker = parseSqliteSessionFileMarker(trimmed);
      if (
        sqliteMarker &&
        normalizeAgentId(sqliteMarker.agentId) === normalizeAgentId(this.agentId)
      ) {
        normalized.add(trimmed);
        continue;
      }
      const resolved = path.resolve(trimmed);
      if (
        this.isSessionFileForAgent(resolved) &&
        parseCanonicalSessionSyncTargetFromPath(resolved)
      ) {
        normalized.add(resolved);
        continue;
      }
      if (corpusPaths.has(resolved)) {
        normalized.add(resolved);
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  private normalizeTargetSessions(
    sessions?: MemorySessionSyncTarget[],
  ): Map<string, MemorySessionSyncTarget> | null {
    if (!sessions || sessions.length === 0) {
      return null;
    }
    const normalized = new Map<string, MemorySessionSyncTarget>();
    for (const session of sessions) {
      const sessionId = session.sessionId.trim();
      const agentId = session.agentId?.trim() || this.agentId;
      if (!sessionId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
        continue;
      }
      const sessionKey = session.sessionKey?.trim();
      const target = {
        agentId,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
      };
      normalized.set(this.memorySessionSyncTargetKey(target), target);
    }
    return normalized.size > 0 ? normalized : null;
  }

  private async resolveArchiveFilesForSyncTargets(
    sessions?: Iterable<MemorySessionSyncTarget> | null,
    knownCorpusEntries?: readonly SessionTranscriptCorpusEntry[],
  ): Promise<Set<string>> {
    const files = new Set<string>();
    const targets = Array.from(sessions ?? []);
    if (targets.length === 0) {
      return files;
    }
    const corpusEntries =
      knownCorpusEntries ?? (await listSessionTranscriptCorpusEntriesForAgent(this.agentId));
    for (const session of targets) {
      const sessionKey = session.sessionKey?.trim();
      let matchedCorpusEntry = false;
      for (const entry of corpusEntries) {
        if (normalizeAgentId(entry.agentId) !== normalizeAgentId(this.agentId)) {
          continue;
        }
        if (entry.sessionId !== session.sessionId) {
          continue;
        }
        if (sessionKey && entry.sessionKey !== sessionKey) {
          continue;
        }
        files.add(
          entry.transcriptSource === "sqlite" ? entry.sessionFile : path.resolve(entry.sessionFile),
        );
        matchedCorpusEntry = true;
      }
      if (matchedCorpusEntry) {
        continue;
      }
      const resolved = resolveSessionFileForSyncTarget(session, this.agentId);
      if (!resolved || normalizeAgentId(resolved.agentId) !== normalizeAgentId(this.agentId)) {
        continue;
      }
      const sessionFile = path.resolve(resolved.sessionFile);
      if (
        this.isSessionFileForAgent(sessionFile) &&
        parseCanonicalSessionSyncTargetFromPath(sessionFile)
      ) {
        files.add(sessionFile);
      }
    }
    return files;
  }

  private async combineTargetArchiveFiles(params: {
    sessions?: MemorySessionSyncTarget[];
    archiveFiles?: string[];
  }): Promise<Set<string> | null> {
    const files = new Set<string>();
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    for (const file of this.normalizeTargetArchiveFiles(params.archiveFiles, corpusEntries) ?? []) {
      files.add(file);
    }
    for (const file of await this.resolveArchiveFilesForSyncTargets(
      this.normalizeTargetSessions(params.sessions)?.values(),
      corpusEntries,
    )) {
      files.add(file);
    }
    return files.size > 0 ? files : null;
  }

  private memorySessionSyncTargetKey(target: MemorySessionSyncTarget): string {
    return [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0");
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = resolveTimerTimeoutMs(minutes * 60 * 1000, 0, 0);
    if (ms <= 0) {
      return;
    }
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      runDetachedMemorySync(async () => {
        if (this.closed) {
          return;
        }
        if (!(await settleMemoryWatchEventPaths(this.pendingWatchPaths))) {
          if (!this.closed) {
            this.scheduleWatchSync();
          }
          return;
        }
        if (this.closed) {
          return;
        }
        await this.sync({ reason: "watch" });
      }, "watch");
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(params?: MemorySyncParams, needsFullReindex = false) {
    return shouldSyncSessionsForReindex({
      hasSessionSource: this.sources.has("sessions"),
      sessionsDirty: this.sessionsDirty,
      sessionsFullRetryDirty: this.sessionsFullRetryDirty,
      dirtySessionFileCount: this.sessionsDirtyFiles.size,
      sync: params,
      needsFullReindex,
    });
  }

  private async syncMemoryFiles(params: {
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
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM memory_index_chunks WHERE path = ? AND source = ?)`,
          )
        : null;
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
        if (deleteVectorRowsByPathAndSource) {
          try {
            deleteVectorRowsByPathAndSource.run(stale.path, "memory");
          } catch {}
        }
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

  private async syncArchiveFiles(params: {
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
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM memory_index_chunks WHERE path = ? AND source = ?)`,
          )
        : null;
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
          return sessionPathForCorpusEntry(corpusEntry);
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
      if (deleteVectorRowsByPathAndSource) {
        try {
          deleteVectorRowsByPathAndSource.run(memoryPath, "sessions");
        } catch {}
      }
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
          .map((entry) => sessionPathForCorpusEntry(entry)),
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
          legacyExtensionlessSessionPathForIdentity(staleAgentId, sessionId),
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
                  corpusEntry ? buildSessionEntryOptions(corpusEntry) : undefined,
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
          corpusEntry ? buildSessionEntryOptions(corpusEntry) : undefined,
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
        metaKey: META_KEY,
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
