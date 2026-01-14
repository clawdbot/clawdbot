import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";

import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveUserPath, truncateUtf16Safe } from "../utils.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
} from "./embeddings.js";
import {
  buildFileEntry,
  chunkMarkdown,
  cosineSimilarity,
  ensureDir,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  type MemoryFileEntry,
  normalizeRelPath,
  parseEmbedding,
} from "./internal.js";

const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  const onWarning = (warning: Error & { name?: string; message?: string }) => {
    if (
      warning.name === "ExperimentalWarning" &&
      warning.message?.includes("SQLite is an experimental feature")
    ) {
      return;
    }
    process.stderr.write(`${warning.stack ?? warning.toString()}\n`);
  };

  process.on("warning", onWarning);
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.off("warning", onWarning);
  }
}

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
};

type MemoryIndexMeta = {
  model: string;
  provider: string;
  chunkTokens: number;
  chunkOverlap: number;
};

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;

const INDEX_CACHE = new Map<string, MemoryIndexManager>();

export class MemoryIndexManager {
  private readonly cacheKey: string;
  private readonly cfg: ClawdbotConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local";
  private readonly fallbackReason?: string;
  private readonly db: DatabaseSync;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = false;
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
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
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
    this.db = this.openDatabase();
    this.ensureSchema();
    this.ensureWatcher();
    this.ensureIntervalSync();
    this.dirty = true;
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
    if (this.settings.sync.onSearch && this.dirty) {
      await this.sync({ reason: "search" });
    }
    const cleaned = query.trim();
    if (!cleaned) return [];
    const queryVec = await this.provider.embedQuery(cleaned);
    if (queryVec.length === 0) return [];
    const candidates = this.listChunks();
    const scored = candidates
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVec, chunk.embedding),
      }))
      .filter((entry) => Number.isFinite(entry.score));
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    return scored
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((entry) => ({
        path: entry.chunk.path,
        startLine: entry.chunk.startLine,
        endLine: entry.chunk.endLine,
        score: entry.score,
        snippet: truncateUtf16Safe(entry.chunk.text, SNIPPET_MAX_CHARS),
      }));
  }

  async sync(params?: { reason?: string; force?: boolean }): Promise<void> {
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
    fallback?: { from: string; reason?: string };
  } {
    const files = this.db.prepare(`SELECT COUNT(*) as c FROM files`).get() as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks`)
      .get() as {
      c: number;
    };
    return {
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      fallback: this.fallbackReason
        ? { from: "local", reason: this.fallbackReason }
        : undefined,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }

  private openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    return new DatabaseSync(dbPath);
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  }

  private ensureWatcher() {
    if (!this.settings.sync.watch || this.watcher) return;
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

  private ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) return;
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" });
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.settings.sync.watch) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" });
    }, this.settings.sync.watchDebounceMs);
  }

  private listChunks(): Array<{
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    embedding: number[];
  }> {
    const rows = this.db
      .prepare(
        `SELECT path, start_line, end_line, text, embedding FROM chunks WHERE model = ?`,
      )
      .all(this.provider.model) as Array<{
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
    }>;
    return rows.map((row) => ({
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      embedding: parseEmbedding(row.embedding),
    }));
  }

  private async runSync(params?: { reason?: string; force?: boolean }) {
    const meta = this.readMeta();
    const needsFullReindex =
      params?.force ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.chunkTokens !== this.settings.chunking.tokens ||
      meta.chunkOverlap !== this.settings.chunking.overlap;
    if (needsFullReindex) {
      this.resetIndex();
    }

    const files = await listMemoryFiles(this.workspaceDir);
    const fileEntries = await Promise.all(
      files.map(async (file) => buildFileEntry(file, this.workspaceDir)),
    );
    const activePaths = new Set(fileEntries.map((entry) => entry.path));

    for (const entry of fileEntries) {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ?`)
        .get(entry.path) as { hash: string } | undefined;
      if (!needsFullReindex && record?.hash === entry.hash) {
        continue;
      }
      await this.indexFile(entry);
    }

    const staleRows = this.db.prepare(`SELECT path FROM files`).all() as Array<{
      path: string;
    }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) continue;
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(stale.path);
      this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(stale.path);
    }

    this.writeMeta({
      model: this.provider.model,
      provider: this.provider.id,
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
    });
    this.dirty = false;
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
  }

  private readMeta(): MemoryIndexMeta | null {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(META_KEY) as { value: string } | undefined;
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

  private async indexFile(entry: MemoryFileEntry) {
    const content = await fs.readFile(entry.absPath, "utf-8");
    const chunks = chunkMarkdown(content, this.settings.chunking);
    const embeddings = await this.provider.embedBatch(
      chunks.map((chunk) => chunk.text),
    );
    const now = Date.now();
    this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(entry.path);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );
    }
    this.db
      .prepare(
        `INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`,
      )
      .run(entry.path, entry.hash, entry.mtimeMs, entry.size);
  }
}

export type MemorySearchManagerResult = {
  manager: MemoryIndexManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  try {
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}
