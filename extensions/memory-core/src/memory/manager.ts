import type { DatabaseSync } from "node:sqlite";
import { type FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  readMemoryFile,
  type MemoryEmbeddingProbeResult,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySearchResult,
  type MemorySource,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { awaitPendingManagerWork, startAsyncSearchSync } from "./manager-async-state.js";
import { MEMORY_BATCH_FAILURE_LIMIT } from "./manager-batch-state.js";
import {
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
  resolveSingletonManagedCache,
} from "./manager-cache.js";
import { closeMemoryDatabase } from "./manager-db.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import {
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import {
  collectMemoryStatusAggregate,
  resolveInitialMemoryDirty,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";
import {
  enqueueMemoryTargetedSessionSync,
  extractMemoryErrorReason,
  isMemoryReadonlyDbError,
  runMemorySyncWithReadonlyRecovery,
  type MemoryReadonlyRecoveryState,
} from "./manager-sync-control.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");
export const EMBEDDING_PROBE_CACHE_TTL_MS = 30_000;
const log = createSubsystemLogger("memory");
type MemoryIndexManagerPurpose = "default" | "status" | "cli";

const { cache: INDEX_CACHE, pending: INDEX_CACHE_PENDING } =
  resolveSingletonManagedCache<MemoryIndexManager>(MEMORY_INDEX_MANAGER_CACHE_KEY);

type EmbeddingProbeCacheEntry = {
  result: MemoryEmbeddingProbeResult;
  checkedAtMs: number;
  expireAtMs: number;
};

const EMBEDDING_PROBE_CACHE = new Map<string, EmbeddingProbeCacheEntry>();

export async function closeAllMemoryIndexManagers(): Promise<void> {
  EMBEDDING_PROBE_CACHE.clear();
  await closeManagedCacheEntries({
    cache: INDEX_CACHE,
    pending: INDEX_CACHE_PENDING,
    onCloseError: (err) => {
      log.warn(`failed to close memory index manager: ${String(err)}`);
    },
  });
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider: EmbeddingProviderRequest;
  private providerInitPromise: Promise<void> | null = null;
  private providerInitialized = false;
  protected fallbackFrom?: EmbeddingProviderId;
  protected fallbackReason?: string;
  private providerUnavailableReason?: string;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected sessionsDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private queuedSessionFiles = new Set<string>();
  private queuedSessionSync: Promise<void> | null = null;
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;

  private static async loadProviderResult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    settings: ResolvedMemorySearchConfig;
  }): Promise<EmbeddingProviderResult> {
    return await createEmbeddingProvider({
      config: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      ...resolveMemoryPrimaryProviderRequest({ settings: params.settings }),
    });
  }

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: MemoryIndexManagerPurpose;
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const purpose =
      params.purpose === "status" || params.purpose === "cli" ? params.purpose : "default";
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}:${purpose}`;
    const transient = purpose === "status" || purpose === "cli";
    return await getOrCreateManagedCacheEntry({
      cache: INDEX_CACHE,
      pending: INDEX_CACHE_PENDING,
      key,
      bypassCache: transient,
      create: async () =>
        new MemoryIndexManager({
          cacheKey: key,
          cfg,
          agentId,
          workspaceDir,
          settings,
          purpose: params.purpose,
        }),
    });
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult?: EmbeddingProviderResult;
    purpose?: MemoryIndexManagerPurpose;
  }) {
    super();
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = null;
    this.requestedProvider = params.settings.provider;
    if (params.providerResult) {
      this.applyProviderResult(params.providerResult);
    }
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
    this.ensureSchema();
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    const transient = params.purpose === "status" || params.purpose === "cli";
    if (!transient) {
      this.ensureWatcher();
      this.ensureSessionListener();
      this.ensureIntervalSync();
    }
    this.dirty = resolveInitialMemoryDirty({
      hasMemorySource: this.sources.has("memory"),
      statusOnly: params.purpose === "status",
      hasIndexedMeta: Boolean(meta),
    });
    this.batch = this.resolveBatchConfig();
  }

  private applyProviderResult(providerResult: EmbeddingProviderResult): void {
    const providerState = resolveMemoryProviderState(providerResult);
    this.provider = providerState.provider;
    this.fallbackFrom = providerState.fallbackFrom;
    this.fallbackReason = providerState.fallbackReason;
    this.providerUnavailableReason = providerState.providerUnavailableReason;
    this.providerRuntime = providerState.providerRuntime;
    this.providerInitialized = true;
  }

  private async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        const providerResult = await MemoryIndexManager.loadProviderResult({
          cfg: this.cfg,
          agentId: this.agentId,
          settings: this.settings,
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      /** When set, only these chunk sources are considered (must be enabled for this manager). */
      sources?: MemorySource[];
    },
  ): Promise<MemorySearchResult[]> {
    opts?.onDebug?.({ backend: "builtin" });
    let hasIndexedContent = this.hasIndexedContent();
    if (!hasIndexedContent) {
      try {
        // A fresh process can receive its first search before background watch/session
        // syncs have built the index. Force one synchronous bootstrap so the first
        // lookup after restart does not fail closed with empty results.
        await this.sync({ reason: "search", force: true });
      } catch (err) {
        log.warn(`memory sync failed (search-bootstrap): ${String(err)}`);
      }
      hasIndexedContent = this.hasIndexedContent();
    }
    const preflight = resolveMemorySearchPreflight({
      query,
      hasIndexedContent,
    });
    if (!preflight.shouldSearch) {
      return [];
    }
    const cleaned = preflight.normalizedQuery;
    void this.warmSession(opts?.sessionKey);
    startAsyncSearchSync({
      enabled: this.settings.sync.onSearch,
      dirty: this.dirty,
      sessionsDirty: this.sessionsDirty,
      sync: async (params) => await this.sync(params),
      onError: (err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      },
    });
    if (preflight.shouldInitializeProvider) {
      await this.ensureProviderInitialized();
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const searchSources =
      opts?.sources && opts.sources.length > 0
        ? [...new Set(opts.sources)].filter((s) => this.sources.has(s))
        : undefined;
    if (
      opts?.sources &&
      opts.sources.length > 0 &&
      (!searchSources || searchSources.length === 0)
    ) {
      return [];
    }
    const sourceFilterList = searchSources ?? [...this.sources];
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // FTS-only mode: no embedding provider available
    if (!this.provider) {
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        return [];
      }

      const fullQueryResults = await this.searchKeyword(
        cleaned,
        candidates,
        {
          boostFallbackRanking: true,
        },
        sourceFilterList,
      ).catch(() => []);
      const resultSets =
        fullQueryResults.length > 0
          ? [fullQueryResults]
          : await Promise.all(
              // Fallback: broaden recall for conversational queries when the
              // exact AND query is too strict to return any results.
              (() => {
                const keywords = extractKeywords(cleaned, {
                  ftsTokenizer: this.settings.store.fts.tokenizer,
                });
                const searchTerms = keywords.length > 0 ? keywords : [cleaned];
                return searchTerms.map((term) =>
                  this.searchKeyword(
                    term,
                    candidates,
                    { boostFallbackRanking: true },
                    sourceFilterList,
                  ).catch(() => []),
                );
              })(),
            );

      // Merge and deduplicate results, keeping highest score for each chunk
      const seenIds = new Map<string, (typeof resultSets)[0][0]>();
      for (const results of resultSets) {
        for (const result of results) {
          const existing = seenIds.get(result.id);
          if (!existing || result.score > existing.score) {
            seenIds.set(result.id, result);
          }
        }
      }

      const merged = [...seenIds.values()];
      const decayed = await applyTemporalDecayToHybridResults({
        results: merged,
        temporalDecay: hybrid.temporalDecay,
        workspaceDir: this.workspaceDir,
      });
      const sorted = decayed.toSorted((a, b) => b.score - a.score);
      return this.selectScoredResults(sorted, maxResults, minScore, 0);
    }

    // If FTS isn't available, hybrid mode cannot use keyword search; degrade to vector-only.
    const keywordResults =
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeyword(cleaned, candidates, undefined, sourceFilterList).catch(() => [])
        : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates, sourceFilterList).catch(() => [])
      : [];

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = await this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });
    const strict = merged.filter((entry) => entry.score >= minScore);
    if (strict.length > 0 || keywordResults.length === 0) {
      return strict.slice(0, maxResults);
    }

    // Hybrid defaults can produce keyword-only matches with max score equal to
    // textWeight (for example 0.3). If minScore is higher (for example 0.35),
    // these exact lexical hits get filtered out even when they are the only
    // relevant results.
    const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    return this.selectScoredResults(
      merged.filter((entry) =>
        keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`),
      ),
      maxResults,
      minScore,
      relaxedMinScore,
    );
  }

  private selectScoredResults<T extends MemorySearchResult & { score: number }>(
    results: T[],
    maxResults: number,
    minScore: number,
    relaxedMinScore = minScore,
  ): T[] {
    const strict = results.filter((entry) => entry.score >= minScore);
    if (strict.length > 0) {
      return strict.slice(0, maxResults);
    }
    return results.filter((entry) => entry.score >= relaxedMinScore).slice(0, maxResults);
  }

  private hasIndexedContent(): boolean {
    const chunkRow = this.db.prepare(`SELECT 1 as found FROM chunks LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    if (chunkRow?.found === 1) {
      return true;
    }
    if (!this.fts.enabled || !this.fts.available) {
      return false;
    }
    const ftsRow = this.db.prepare(`SELECT 1 as found FROM ${FTS_TABLE} LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    return ftsRow?.found === 1;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    sourceFilterList: MemorySource[],
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    // This method should never be called without a provider
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c", sourceFilterList),
      sourceFilterChunks: this.buildSourceFilter(undefined, sourceFilterList),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
    options?: { boostFallbackRanking?: boolean },
    sourceFilterList?: MemorySource[],
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter(undefined, sourceFilterList);
    // In FTS-only mode (no provider), search all models; otherwise filter by current provider's model
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel,
      query,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
      boostFallbackRanking: options?.boostFallbackRanking,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.ensureProviderInitialized();
    if (this.syncing) {
      if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
        return this.enqueueTargetedSessionSync(params.sessionFiles);
      }
      return this.syncing;
    }
    this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private enqueueTargetedSessionSync(sessionFiles?: string[]): Promise<void> {
    return enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => this.closed,
        getSyncing: () => this.syncing,
        getQueuedSessionFiles: () => this.queuedSessionFiles,
        getQueuedSessionSync: () => this.queuedSessionSync,
        setQueuedSessionSync: (value) => {
          this.queuedSessionSync = value;
        },
        sync: async (params) => await this.sync(params),
      },
      sessionFiles,
    );
  }

  private isReadonlyDbError(err: unknown): boolean {
    return isMemoryReadonlyDbError(err);
  }

  private extractErrorReason(err: unknown): string {
    return extractMemoryErrorReason(err);
  }

  private async runSyncWithReadonlyRecovery(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const getClosed = () => this.closed;
    const getDb = () => this.db;
    const setDb = (value: DatabaseSync) => {
      this.db = value;
    };
    const getReadonlyRecoveryAttempts = () => this.readonlyRecoveryAttempts;
    const setReadonlyRecoveryAttempts = (value: number) => {
      this.readonlyRecoveryAttempts = value;
    };
    const getReadonlyRecoverySuccesses = () => this.readonlyRecoverySuccesses;
    const setReadonlyRecoverySuccesses = (value: number) => {
      this.readonlyRecoverySuccesses = value;
    };
    const getReadonlyRecoveryFailures = () => this.readonlyRecoveryFailures;
    const setReadonlyRecoveryFailures = (value: number) => {
      this.readonlyRecoveryFailures = value;
    };
    const getReadonlyRecoveryLastError = () => this.readonlyRecoveryLastError;
    const setReadonlyRecoveryLastError = (value: string | undefined) => {
      this.readonlyRecoveryLastError = value;
    };
    const state: MemoryReadonlyRecoveryState = {
      get closed() {
        return getClosed();
      },
      get db() {
        return getDb();
      },
      set db(value) {
        setDb(value);
      },
      vector: this.vector,
      get readonlyRecoveryAttempts() {
        return getReadonlyRecoveryAttempts();
      },
      set readonlyRecoveryAttempts(value) {
        setReadonlyRecoveryAttempts(value);
      },
      get readonlyRecoverySuccesses() {
        return getReadonlyRecoverySuccesses();
      },
      set readonlyRecoverySuccesses(value) {
        setReadonlyRecoverySuccesses(value);
      },
      get readonlyRecoveryFailures() {
        return getReadonlyRecoveryFailures();
      },
      set readonlyRecoveryFailures(value) {
        setReadonlyRecoveryFailures(value);
      },
      get readonlyRecoveryLastError() {
        return getReadonlyRecoveryLastError();
      },
      set readonlyRecoveryLastError(value) {
        setReadonlyRecoveryLastError(value);
      },
      runSync: (nextParams) => this.runSync(nextParams),
      openDatabase: () => this.openDatabase(),
      closeDatabase: (db) => closeMemoryDatabase(db),
      resetVectorState: () => this.resetVectorState(),
      ensureSchema: () => this.ensureSchema(),
      readMeta: () => this.readMeta() ?? undefined,
    };
    await runMemorySyncWithReadonlyRecovery(state, params);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return await readMemoryFile({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const aggregateState = collectMemoryStatusAggregate({
      db: {
        prepare: (sql) => ({
          all: (...args) =>
            this.db.prepare(sql).all(...args) as Array<{
              kind: "files" | "chunks";
              source: MemorySource;
              c: number;
            }>,
        }),
      },
      sources: this.sources,
      sourceFilterSql: sourceFilter.sql,
      sourceFilterParams: sourceFilter.params,
    });

    const providerInfo = resolveStatusProviderInfo({
      provider: this.provider,
      providerInitialized: this.providerInitialized,
      requestedProvider: this.requestedProvider,
      configuredModel: this.settings.model || undefined,
    });

    return {
      backend: "builtin",
      files: aggregateState.files,
      chunks: aggregateState.chunks,
      dirty: this.dirty || this.sessionsDirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts: aggregateState.sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: MEMORY_BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        searchMode: providerInfo.searchMode,
        providerUnavailableReason: this.providerUnavailableReason,
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          successes: this.readonlyRecoverySuccesses,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
        },
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: vector search not available
    if (!this.provider) {
      return false;
    }
    return this.ensureVectorReady();
  }

  private cacheProbeResult(result: MemoryEmbeddingProbeResult): MemoryEmbeddingProbeResult {
    const checkedAtMs = Date.now();
    EMBEDDING_PROBE_CACHE.set(this.cacheKey, {
      result,
      checkedAtMs,
      expireAtMs: checkedAtMs + EMBEDDING_PROBE_CACHE_TTL_MS,
    });
    return result;
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    const cached = EMBEDDING_PROBE_CACHE.get(this.cacheKey);
    if (!cached) {
      return null;
    }
    const nowMs = Date.now();
    if (nowMs >= cached.expireAtMs) {
      EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
      return null;
    }
    return {
      ...cached.result,
      checked: true,
      cached: true,
      checkedAtMs: cached.checkedAtMs,
      cacheExpiresAtMs: cached.expireAtMs,
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const cached = this.getCachedEmbeddingAvailability();
    if (cached) {
      return cached;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: embeddings not available but search still works
    if (!this.provider) {
      return this.cacheProbeResult({
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      });
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      return this.cacheProbeResult({ ok: true });
    } catch (err) {
      const message = formatErrorMessage(err);
      return this.cacheProbeResult({ ok: false, error: message });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pendingSync = this.syncing;
    const pendingProviderInit = this.providerInitPromise;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    await awaitPendingManagerWork({ pendingSync, pendingProviderInit });
    closeMemoryDatabase(this.db);
    INDEX_CACHE.delete(this.cacheKey);
  }
}
