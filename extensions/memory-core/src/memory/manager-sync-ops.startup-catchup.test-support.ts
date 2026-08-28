// Shared harness and fixtures for manager sync-ops startup catch-up tests.
import { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_CHUNKING_VERSION,
  type MemorySource,
  type MemorySyncParams,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  MEMORY_INDEX_PROVENANCE_VERSION,
  resolveConfiguredScopeHash,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

type SyncParams = {
  reason?: string;
  force?: boolean;
  sessions?: MemorySyncParams["sessions"];
  archiveFiles?: string[];
  progress?: (update: MemorySyncProgressUpdate) => void;
};

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

const originalStartupStateDir = process.env.OPENCLAW_STATE_DIR;
const originalStartupConfigPath = process.env.OPENCLAW_CONFIG_PATH;
let transcriptUpdateListener: ((update: MemorySessionTranscriptUpdate) => void) | undefined;

/** Clears the module-owned listener between tests; ESM bindings cannot be reassigned by importers. */
export function resetTranscriptUpdateListener(): void {
  transcriptUpdateListener = undefined;
}
export const startupHarnessDatabases = new Set<DatabaseSync>();

type SourceStateRow = { path: string; hash: string; mtime: number; size: number };

function createStartupHarnessDatabase(sourceRows: SourceStateRow[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE memory_index_sources (
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      hash TEXT NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      UNIQUE(path, source)
    );
    CREATE TABLE memory_index_chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE memory_index_source_update_audit (path TEXT NOT NULL);
    CREATE TRIGGER memory_index_source_update_audit_trigger
    AFTER UPDATE ON memory_index_sources
    BEGIN
      INSERT INTO memory_index_source_update_audit (path) VALUES (NEW.path);
    END;
  `);
  const insert = db.prepare(
    `INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'sessions', ?, ?, ?)`,
  );
  for (const row of sourceRows) {
    insert.run(row.path, row.hash, row.mtime, row.size);
  }
  startupHarnessDatabases.add(db);
  return db;
}
export function setStartupStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

export function setStartupConfigPath(configPath: string): void {
  Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
}

export function restoreStartupEnv(): void {
  if (originalStartupStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStartupStateDir);
  }
  if (originalStartupConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
  } else {
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", originalStartupConfigPath);
  }
}

export function emitSessionTranscriptUpdate(update: MemorySessionTranscriptUpdate): void {
  transcriptUpdateListener?.(update);
}

export class SessionStartupCatchupHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    chunking: {
      overlap: 0,
      tokens: 256,
    },
    extraPaths: [],
    multimodal: {
      enabled: false,
      modalities: [],
      maxFileBytes: 0,
    },
    provider: "none",
    store: {
      fts: {
        tokenizer: "unicode61",
      },
      vector: {
        enabled: false,
      },
    },
    sync: {
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    },
  } as unknown as ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected publishedDatabase: MemoryIndexDatabase;

  readonly syncCalls: SyncParams[] = [];
  readonly indexedPaths: string[] = [];
  readonly indexedContents: string[] = [];
  corpusListCalls = 0;
  private afterNextCorpusList: (() => Promise<void>) | null = null;
  private corpusListWork: Promise<void> = Promise.resolve();
  private pendingSyncWork: Promise<void> = Promise.resolve();

  constructor(
    sourceRows: SourceStateRow[],
    private readonly indexSessionUpdates = false,
    private readonly subscribeToRealEvents = false,
    private readonly deferSessionIndex = false,
    database?: DatabaseSync,
  ) {
    super();
    this.sources.add("sessions");
    const db = database ?? createStartupHarnessDatabase(sourceRows);
    this.publishedDatabase = new MemoryIndexDatabase(db);
  }

  restartForStartup(): SessionStartupCatchupHarness {
    return new SessionStartupCatchupHarness(
      [],
      this.indexSessionUpdates,
      false,
      this.deferSessionIndex,
      this.db,
    );
  }

  getIndexedSourceState(pathname: string): SourceStateRow | undefined {
    return this.db
      .prepare(
        `SELECT path, hash, mtime, size FROM memory_index_sources WHERE path = ? AND source = 'sessions'`,
      )
      .get(pathname) as SourceStateRow | undefined;
  }

  getSourceMetadataUpdateCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM memory_index_source_update_audit`)
      .get() as { count: number };
    return row.count;
  }

  async catchUp(): Promise<string[]> {
    return await this.runSessionStartupCatchup();
  }

  async markStartupDirtyFiles(): Promise<string[]> {
    return await this.markSessionStartupCatchupDirtyFiles();
  }

  async runSyncForTest(params?: MemorySyncParams): Promise<void> {
    await this.runSync(params);
  }

  async runArchiveSyncForTest(): Promise<void> {
    await this.syncArchiveFiles({
      needsFullReindex: false,
      deferIndex: this.deferSessionIndex,
    });
  }

  async getCorpusPathsForTest(): Promise<string[]> {
    const entries = await this.listSessionCorpusEntries();
    return entries.map((entry) => this.sessionPathForCorpusEntry(entry));
  }

  getDirtyArchiveFiles(): string[] {
    return Array.from(this.sessionsDirtyFiles);
  }

  getPendingSessionTargets(): MemorySyncParams["sessions"] {
    return Array.from(this.sessionPendingTargets.values());
  }

  getPendingArchiveFiles(): string[] {
    return Array.from(this.sessionPendingFiles);
  }

  addPendingSessionTarget(target: NonNullable<MemorySyncParams["sessions"]>[number]): void {
    this.sessionPendingTargets.set(
      [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0"),
      target,
    );
  }

  async processPendingSessionUpdates(): Promise<void> {
    await (
      this as unknown as {
        processSessionUpdateBatch: () => Promise<void>;
      }
    ).processSessionUpdateBatch();
  }

  async waitForCorpusList(): Promise<void> {
    await this.corpusListWork;
    await Promise.resolve();
  }

  async waitForSessionSync(): Promise<void> {
    await this.pendingSyncWork;
  }

  afterNextCorpusListForTest(callback: () => Promise<void>): void {
    this.afterNextCorpusList = callback;
  }

  isSessionsDirty(): boolean {
    return this.sessionsDirty;
  }

  markFullSessionRetry(): void {
    this.sessionsDirty = true;
    this.sessionsFullRetryDirty = true;
  }

  startTranscriptListener(): void {
    this.ensureSessionListener();
  }

  stopTranscriptListener(): void {
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
  }

  protected override subscribeSessionTranscriptUpdates(
    listener: (update: MemorySessionTranscriptUpdate) => void,
  ): () => void {
    if (this.subscribeToRealEvents) {
      return super.subscribeSessionTranscriptUpdates(listener);
    }
    transcriptUpdateListener = listener;
    return () => {
      if (transcriptUpdateListener === listener) {
        transcriptUpdateListener = undefined;
      }
    };
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected override readMeta(): MemoryIndexMeta {
    return {
      model: "fts-only",
      provider: "none",
      sources: ["sessions"],
      scopeHash: resolveConfiguredScopeHash({
        workspaceDir: this.workspaceDir,
        extraPaths: this.settings.extraPaths,
        multimodal: this.settings.multimodal,
      }),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
    };
  }

  protected async sync(params?: MemorySyncParams): Promise<void> {
    this.syncCalls.push(params ?? {});
    this.pendingSyncWork = this.indexSessionUpdates
      ? this.syncArchiveFiles({
          needsFullReindex: false,
          deferIndex: this.deferSessionIndex,
        }).then(() => undefined)
      : Promise.resolve();
    await this.pendingSyncWork;
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    _timeoutMs: number,
    _message: string,
  ): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected override listSessionCorpusEntries() {
    const work = super.listSessionCorpusEntries().then(async (entries) => {
      this.corpusListCalls += 1;
      const callback = this.afterNextCorpusList;
      this.afterNextCorpusList = null;
      await callback?.();
      return entries;
    });
    this.corpusListWork = work.then(() => undefined);
    return work;
  }

  embeddingCachePrunes = 0;

  protected pruneEmbeddingCacheIfNeeded(): void {
    this.embeddingCachePrunes += 1;
  }

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void> {
    this.indexedPaths.push(entry.path);
    this.indexedContents.push(options.content ?? "");
  }
}
