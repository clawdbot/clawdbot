import fs from "node:fs/promises";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";

import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { resolveUserPath } from "../utils.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type OpenAiEmbeddingClient,
} from "./embeddings.js";
import {
  OPENAI_BATCH_ENDPOINT,
  type OpenAiBatchRequest,
  runOpenAiEmbeddingBatches,
} from "./openai-batch.js";
import {
  chunkMarkdown,
  ensureDir,
  hashText,
  isMemoryPath,
  type MemoryChunk,
  type MemoryFileEntry,
  normalizeRelPath,
  parseEmbedding,
} from "./internal.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { computeMemoryManagerCacheKey } from "./manager-cache-key.js";
import { computeEmbeddingProviderKey } from "./provider-key.js";
import { requireNodeSqlite } from "./sqlite.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import type { SessionFileEntry } from "./session-files.js";
import { syncMemoryFiles } from "./sync-memory-files.js";
import { syncSessionFiles } from "./sync-session-files.js";

type MemorySource = "memory" | "sessions";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
};

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_APPROX_CHARS_PER_TOKEN = 1;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;

const log = createSubsystemLogger("memory");

const INDEX_CACHE = new Map<string, MemoryIndexManager>();

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export class MemoryIndexManager {
  private readonly cacheKey: string;
  private readonly cfg: ClawdbotConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local";
  private readonly fallbackReason?: string;
  private readonly openAi?: OpenAiEmbeddingClient;
  private readonly batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  private readonly db: DatabaseSync;
  private readonly sources: Set<MemorySource>;
  private readonly providerKey: string;
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  private vectorReady: Promise<boolean> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private sessionWatchTimer: NodeJS.Timeout | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = false;
  private sessionsDirty = false;
  private sessionsDirtyFiles = new Set<string>();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;

  static async get(params: {
    cfg: ClawdbotConfig;
    agentId: string;
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) return null;
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = computeMemoryManagerCacheKey({ agentId, workspaceDir, settings });
    const existing = INDEX_CACHE.get(key);
    if (existing) return existing;
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings,
      providerResult,
    });
    INDEX_CACHE.set(key, manager);
    return manager;
  }

  private constructor(params: {
    cacheKey: string;
    cfg: ClawdbotConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
  }) {
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.openAi = params.providerResult.openAi;
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = computeEmbeddingProviderKey({
      providerId: this.provider.id,
      providerModel: this.provider.model,
      openAi: this.openAi
        ? { baseUrl: this.openAi.baseUrl, model: this.openAi.model, headers: this.openAi.headers }
        : undefined,
    });
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
    this.ensureWatcher();
    this.ensureSessionListener();
    this.ensureIntervalSync();
    this.dirty = this.sources.has("memory");
    if (this.sources.has("sessions")) {
      this.sessionsDirty = true;
    }
    const batch = params.settings.remote?.batch;
    this.batch = {
      enabled: Boolean(batch?.enabled && this.openAi && this.provider.id === "openai"),
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) return;
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) return;
    await this.sync({ reason: "session-start" });
    if (key) this.sessionWarm.add(key);
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    await this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      await this.sync({ reason: "search" });
    }
    const cleaned = query.trim();
    if (!cleaned) return [];
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const keywordResults = hybrid.enabled
      ? await this.searchKeyword(cleaned, candidates).catch(() => [])
      : [];

    const queryVec = await this.provider.embedQuery(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
    });

    return merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) return [];
    const sourceFilter = this.buildSourceFilter();
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.provider.model,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
  }): MemorySearchResult[] {
    const merged = mergeHybridResults({
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
    });
    return merged.map((entry) => entry as MemorySearchResult);
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const relPath = normalizeRelPath(params.relPath);
    if (!relPath || !isMemoryPath(relPath)) {
      throw new Error("path required");
    }
    const absPath = path.resolve(this.workspaceDir, relPath);
    if (!absPath.startsWith(this.workspaceDir)) {
      throw new Error("path escapes workspace");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): {
    files: number;
    chunks: number;
    dirty: boolean;
    workspaceDir: string;
    dbPath: string;
    provider: string;
    model: string;
    requestedProvider: string;
    sources: MemorySource[];
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
    cache?: { enabled: boolean; entries?: number; maxEntries?: number };
    fts?: { enabled: boolean; available: boolean; error?: string };
    fallback?: { from: string; reason?: string };
    vector?: {
      enabled: boolean;
      available?: boolean;
      extensionPath?: string;
      loadError?: string;
      dims?: number;
    };
  } {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) return [];
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => ({ source, ...bySource.get(source)! }));
    })();
    return {
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      sourceCounts,
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
      fallback: this.fallbackReason ? { from: "local", reason: this.fallbackReason } : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) return false;
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }

  private async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) return false;
    if (!this.vectorReady) {
      this.vectorReady = this.loadVectorExtension();
    }
    const ready = await this.vectorReady;
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) return this.vector.available;
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) return;
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  private buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) return { sql: "", params: [] };
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  private openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    return new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
  }

  private ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      log.warn(`fts unavailable: ${result.ftsError}`);
    }
  }

  private ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) return;
    const watchPaths = [
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory"),
    ];
    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  private ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) return;
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) return;
      const sessionFile = update.sessionFile;
      if (!this.isSessionFileForAgent(sessionFile)) return;
      this.scheduleSessionDirty(sessionFile);
    });
  }

  private scheduleSessionDirty(sessionFile: string) {
    this.sessionsDirtyFiles.add(sessionFile);
    if (this.sessionWatchTimer) return;
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      this.sessionsDirty = true;
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) return false;
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) return;
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(
    params?: { reason?: string; force?: boolean },
    needsFullReindex = false,
  ) {
    if (!this.sources.has("sessions")) return false;
    if (params?.force) return true;
    const reason = params?.reason;
    if (reason === "session-start" || reason === "watch") return false;
    return this.sessionsDirty || needsFullReindex;
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    await syncMemoryFiles({
      workspaceDir: this.workspaceDir,
      db: this.db,
      needsFullReindex: params.needsFullReindex,
      progress: params.progress,
      batchEnabled: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      runWithConcurrency: this.runWithConcurrency.bind(this),
      indexFile: async (entry) => await this.indexFile(entry, { source: "memory" }),
      vectorTable: VECTOR_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
      ftsAvailable: this.fts.available,
      model: this.provider.model,
    });
  }

  private async syncSessionFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    await syncSessionFiles({
      agentId: this.agentId,
      db: this.db,
      needsFullReindex: params.needsFullReindex,
      progress: params.progress,
      batchEnabled: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      runWithConcurrency: this.runWithConcurrency.bind(this),
      indexFile: async (entry) =>
        await this.indexFile(entry, { source: "sessions", content: entry.content }),
      vectorTable: VECTOR_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
      ftsAvailable: this.fts.available,
      model: this.provider.model,
      dirtyFiles: this.sessionsDirtyFiles,
    });
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) state.label = update.label;
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

  private async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const needsFullReindex =
      params?.force ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.providerKey !== this.providerKey ||
      meta.chunkTokens !== this.settings.chunking.tokens ||
      meta.chunkOverlap !== this.settings.chunking.overlap ||
      (vectorReady && !meta?.vectorDims);
    if (needsFullReindex) {
      this.resetIndex();
    }

    const shouldSyncMemory =
      this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);
    const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionFiles({ needsFullReindex, progress: progress ?? undefined });
      this.sessionsDirty = false;
      this.sessionsDirtyFiles.clear();
    } else if (needsFullReindex && this.sources.has("sessions")) {
      this.sessionsDirty = true;
    }

    const nextMeta: MemoryIndexMeta = {
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
    };
    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }
    if (shouldSyncMemory || shouldSyncSessions || needsFullReindex) {
      this.writeMeta(nextMeta);
    }
    if (shouldSyncMemory || shouldSyncSessions || needsFullReindex) {
      this.pruneEmbeddingCacheIfNeeded();
    }
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DELETE FROM ${FTS_TABLE}`);
      } catch {}
    }
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.sessionsDirtyFiles.clear();
  }

  private readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as MemoryIndexMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
  }

  private estimateEmbeddingTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / EMBEDDING_APPROX_CHARS_PER_TOKEN);
  }

  private buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      const estimate = this.estimateEmbeddingTokens(chunk.text);
      const wouldExceed =
        current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
        batches.push([chunk]);
        continue;
      }
      current.push(chunk);
      currentTokens += estimate;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    if (!this.cache.enabled) return new Map();
    if (hashes.length === 0) return new Map();
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const hash of hashes) {
      if (!hash) continue;
      if (seen.has(hash)) continue;
      seen.add(hash);
      unique.push(hash);
    }
    if (unique.length === 0) return new Map();

    const out = new Map<string, number[]>();
    const baseParams = [this.provider.id, this.provider.model, this.providerKey];
    const batchSize = 400;
    for (let start = 0; start < unique.length; start += batchSize) {
      const batch = unique.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
      for (const row of rows) {
        out.set(row.hash, parseEmbedding(row.embedding));
      }
    }
    return out;
  }

  private upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>): void {
    if (!this.cache.enabled) return;
    if (entries.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
        ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
        ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
        `   embedding=excluded.embedding,\n` +
        `   dims=excluded.dims,\n` +
        `   updated_at=excluded.updated_at`,
    );
    for (const entry of entries) {
      const embedding = entry.embedding ?? [];
      stmt.run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        entry.hash,
        JSON.stringify(embedding),
        embedding.length,
        now,
      );
    }
  }

  private pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) return;
    const max = this.cache.maxEntries;
    if (!max || max <= 0) return;
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
      | { c: number }
      | undefined;
    const count = row?.c ?? 0;
    if (count <= max) return;
    const excess = count - max;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE rowid IN (\n` +
          `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
          `   ORDER BY updated_at ASC\n` +
          `   LIMIT ?\n` +
          ` )`,
      )
      .run(excess);
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) return [];
    const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }

    if (missing.length === 0) return embeddings;

    const missingChunks = missing.map((m) => m.chunk);
    const batches = this.buildEmbeddingBatches(missingChunks);
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    let cursor = 0;
    for (const batch of batches) {
      const batchEmbeddings = await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          toCache.push({ hash: item.chunk.hash, embedding });
        }
      }
      cursor += batch.length;
    }
    this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    if (!this.openAi) {
      return this.embedChunksInBatches(chunks);
    }
    if (chunks.length === 0) return [];
    const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }

    if (missing.length === 0) return embeddings;

    const requests: OpenAiBatchRequest[] = [];
    const mapping = new Map<string, { index: number; hash: string }>();
    for (const item of missing) {
      const chunk = item.chunk;
      const customId = hashText(
        `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${item.index}`,
      );
      mapping.set(customId, { index: item.index, hash: chunk.hash });
      requests.push({
        custom_id: customId,
        method: "POST",
        url: OPENAI_BATCH_ENDPOINT,
        body: {
          model: this.openAi?.model ?? this.provider.model,
          input: chunk.text,
        },
      });
    }
    const byCustomId = await runOpenAiEmbeddingBatches({
      openAi: this.openAi,
      agentId: this.agentId,
      requests,
      wait: this.batch.wait,
      concurrency: this.batch.concurrency,
      pollIntervalMs: this.batch.pollIntervalMs,
      timeoutMs: this.batch.timeoutMs,
      debug: (message, data) => log.debug(message, { ...data, source, chunks: chunks.length }),
    });

    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (const [customId, embedding] of byCustomId.entries()) {
      const mapped = mapping.get(customId);
      if (!mapped) continue;
      embeddings[mapped.index] = embedding;
      toCache.push({ hash: mapped.hash, embedding });
    }
    this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let attempt = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        return await this.provider.embedBatch(texts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        const waitMs = Math.min(
          EMBEDDING_RETRY_MAX_DELAY_MS,
          Math.round(delayMs * (1 + Math.random() * 0.2)),
        );
        log.warn(`memory embeddings rate limited; retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  private isRetryableEmbeddingError(message: string): boolean {
    return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(
      message,
    );
  }

  private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    if (tasks.length === 0) return [];
    const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
    const results: T[] = Array.from({ length: tasks.length });
    let next = 0;
    let firstError: unknown = null;

    const workers = Array.from({ length: resolvedLimit }, async () => {
      while (true) {
        if (firstError) return;
        const index = next;
        next += 1;
        if (index >= tasks.length) return;
        try {
          results[index] = await tasks[index]();
        } catch (err) {
          firstError = err;
          return;
        }
      }
    });

    await Promise.allSettled(workers);
    if (firstError) throw firstError;
    return results;
  }

  private getIndexConcurrency(): number {
    return this.batch.enabled ? this.batch.concurrency : EMBEDDING_INDEX_CONCURRENCY;
  }

  private async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
    const chunks = chunkMarkdown(content, this.settings.chunking).filter(
      (chunk) => chunk.text.trim().length > 0,
    );
    const embeddings = this.batch.enabled
      ? await this.embedChunksWithBatch(chunks, entry, options.source)
      : await this.embedChunksInBatches(chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(entry.path, options.source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, options.source, this.provider.model);
      } catch {}
    }
    this.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(entry.path, options.source);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          entry.path,
          options.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );
      if (vectorReady && embedding.length > 0) {
        this.db
          .prepare(`INSERT OR REPLACE INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }
      if (this.fts.enabled && this.fts.available) {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            entry.path,
            options.source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
      }
    }
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, options.source, entry.hash, entry.mtimeMs, entry.size);
  }
}
