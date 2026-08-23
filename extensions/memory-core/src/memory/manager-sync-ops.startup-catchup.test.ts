// Memory Core tests cover manager sync ops.startup catchup plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  statSessionEntrySync,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  MEMORY_CHUNKING_VERSION,
  type MemorySource,
  type MemorySyncParams,
  type MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const startupHarnessDatabases = new Set<DatabaseSync>();

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
function setStartupStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function setStartupConfigPath(configPath: string): void {
  Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", configPath);
}

function restoreStartupEnv(): void {
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

function emitSessionTranscriptUpdate(update: MemorySessionTranscriptUpdate): void {
  transcriptUpdateListener?.(update);
}

class SessionStartupCatchupHarness extends MemoryManagerSyncOps {
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
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected db: DatabaseSync;

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
    this.db = database ?? createStartupHarnessDatabase(sourceRows);
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

  protected pruneEmbeddingCacheIfNeeded(): void {}

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

describe("session startup catch-up", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-startup-"));
    setStartupStateDir(stateDir);
    transcriptUpdateListener = undefined;
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    transcriptUpdateListener = undefined;
    restoreStartupEnv();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    for (const database of startupHarnessDatabases) {
      database.close();
    }
    startupHarnessDatabases.clear();
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function writeSessionFile(
    name: string,
    content = "startup catchup",
    timestamp?: string,
  ): Promise<{ filePath: string; size: number; mtimeMs: number }> {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, name);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        type: "message",
        ...(timestamp ? { timestamp } : {}),
        message: { role: "user", content },
      }) + "\n",
      "utf-8",
    );
    const stat = await fs.stat(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  async function configureTestSessionStore(storePath: string): Promise<void> {
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ session: { store: storePath } }), "utf-8");
    setStartupConfigPath(configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  }

  async function writeSqliteSession(
    params: {
      storePath?: string;
      sessionId?: string;
      sessionKey?: string;
      content?: string;
      role?: "assistant" | "user";
      updatedAt?: number;
    } = {},
  ): Promise<{
    storePath: string;
    sessionId: string;
    sessionKey: string;
    corpusPath: string;
  }> {
    const storePath =
      params.storePath ?? path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionId = params.sessionId ?? "thread";
    const sessionKey = params.sessionKey ?? `agent:main:chat:${sessionId}`;
    await configureTestSessionStore(storePath);
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId,
        updatedAt: params.updatedAt ?? 10,
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      cwd: stateDir,
      message: {
        role: params.role ?? "user",
        content: params.content ?? "startup catchup",
      },
    });
    return {
      storePath,
      sessionId,
      sessionKey,
      corpusPath: `sessions/main/${sessionId}.jsonl`,
    };
  }

  it("marks stale indexed session files dirty and schedules catch-up sync", async () => {
    const session = await writeSqliteSession();
    const harness = new SessionStartupCatchupHarness([
      {
        path: session.corpusPath,
        hash: "old-hash",
        mtime: 0,
        size: 0,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([session.sessionKey]);
    expect(harness.getDirtyArchiveFiles()).toEqual([session.sessionKey]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
  });

  it("schedules a full retry when invalidated sessions no longer exist", async () => {
    const harness = new SessionStartupCatchupHarness([]);
    harness.markFullSessionRetry();

    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
  });

  it("prunes indexed sessions that are absent from the live corpus", async () => {
    const stalePath = "sessions/main/deleted.jsonl";
    const harness = new SessionStartupCatchupHarness(
      [{ path: stalePath, hash: "stale-hash", mtime: 10, size: 20 }],
      true,
    );

    await expect(harness.catchUp()).resolves.toEqual([]);
    await harness.waitForSessionSync();

    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(harness.getIndexedSourceState(stalePath)).toBeUndefined();
  });

  it("preserves indexed sessions when corpus enumeration fails", async () => {
    const stalePath = "sessions/main/preserved.jsonl";
    const harness = new SessionStartupCatchupHarness(
      [{ path: stalePath, hash: "preserved-hash", mtime: 10, size: 20 }],
      true,
    );
    const scanError = Object.assign(new Error("transient session archive scan failure"), {
      code: "EIO",
    });
    const readdirSpy = vi.spyOn(fsSync, "readdirSync").mockImplementation(() => {
      throw scanError;
    });

    try {
      const catchUp = harness.catchUp();
      const corpusList = harness.waitForCorpusList();
      await expect(catchUp).rejects.toBe(scanError);
      await expect(corpusList).rejects.toBe(scanError);
      expect(harness.syncCalls).toEqual([]);
      expect(harness.getIndexedSourceState(stalePath)).toEqual({
        path: stalePath,
        hash: "preserved-hash",
        mtime: 10,
        size: 20,
      });
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("retries transient session transcript reads during session indexing", async () => {
    const session = await writeSessionFile("thread.jsonl.deleted.2026-02-16T22-27-33.000Z");
    const harness = new SessionStartupCatchupHarness([]);

    const realOpen = fs.open;
    let attempts = 0;
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
        const [target, flags, mode] = args;
        if (
          typeof target === "string" &&
          path.resolve(target) === session.filePath &&
          attempts++ === 0
        ) {
          const err = new Error(
            "Unknown system error -11: Unknown system error -11, open",
          ) as NodeJS.ErrnoException;
          err.code = "UNKNOWN";
          err.errno = -11;
          throw err;
        }
        return await realOpen(target, flags, mode);
      });

    try {
      await (
        harness as unknown as {
          syncArchiveFiles: (params: { needsFullReindex: boolean }) => Promise<void>;
        }
      ).syncArchiveFiles({ needsFullReindex: true });
      expect(attempts).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("can mark startup catch-up files without scheduling background sync", async () => {
    const session = await writeSqliteSession();
    const harness = new SessionStartupCatchupHarness([
      {
        path: session.corpusPath,
        hash: "old-hash",
        mtime: 0,
        size: 0,
      },
    ]);

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([session.sessionKey]);
    expect(harness.getDirtyArchiveFiles()).toEqual([session.sessionKey]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([]);
  });

  it("leaves unchanged indexed SQLite sessions clean during startup catch-up", async () => {
    const session = await writeSqliteSession({ updatedAt: 10 });
    const state = statSessionEntrySync(session.sessionKey, {
      agentId: "main",
      sessionId: session.sessionId,
      storePath: session.storePath,
      sessionKey: session.sessionKey,
      updatedAtMs: 10,
    });
    if (!state) {
      throw new Error("expected SQLite transcript state");
    }
    const harness = new SessionStartupCatchupHarness([
      {
        path: state.path,
        hash: "current-hash",
        mtime: state.mtimeMs,
        size: state.size,
      },
    ]);

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([]);
    expect(harness.getDirtyArchiveFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });

  it("leaves unchanged indexed session files clean", async () => {
    const session = await writeSessionFile("thread.jsonl.deleted.2026-08-09T00-00-00.000Z");
    const discovery = new SessionStartupCatchupHarness([]);
    const [corpusPath] = await discovery.getCorpusPathsForTest();
    if (!corpusPath) {
      throw new Error("expected session transcript corpus path");
    }
    const harness = new SessionStartupCatchupHarness([
      {
        path: corpusPath,
        hash: "current-hash",
        mtime: session.mtimeMs,
        size: session.size,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.getDirtyArchiveFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });

  it("indexes a same-size file transcript whose mtime rolled back", async () => {
    const archiveName = "thread.jsonl.deleted.2026-08-01T10-00-00.000Z";
    const original = await writeSessionFile(archiveName, "version before");
    const originalEntry = await buildSessionEntry(original.filePath);
    if (!originalEntry) {
      throw new Error("expected original file transcript entry");
    }
    const replacement = await writeSessionFile(archiveName, "version after!");
    expect(replacement.size).toBe(original.size);
    const rolledBackMtime = new Date(Math.max(1, original.mtimeMs - 60_000));
    await fs.utimes(replacement.filePath, rolledBackMtime, rolledBackMtime);
    const rolledBack = await fs.stat(replacement.filePath);
    expect(rolledBack.mtimeMs).toBeLessThan(original.mtimeMs);

    const harness = new SessionStartupCatchupHarness(
      [
        {
          path: originalEntry.path,
          hash: originalEntry.hash,
          mtime: original.mtimeMs,
          size: original.size,
        },
      ],
      true,
    );

    await expect(harness.catchUp()).resolves.toEqual([replacement.filePath]);
    await harness.waitForSessionSync();

    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(harness.indexedPaths).toEqual([`sessions/main/${archiveName}`]);
    expect(harness.indexedContents).toEqual(["User: version after!"]);
  });

  it("converges an unchanged file mtime rollback after direct session sync", async () => {
    const archiveName = "thread.jsonl.deleted.2026-08-01T11-00-00.000Z";
    const messageTimestamp = "2026-08-01T10:30:00.000Z";
    const original = await writeSessionFile(archiveName, "unchanged content", messageTimestamp);
    const originalEntry = await buildSessionEntry(original.filePath);
    if (!originalEntry) {
      throw new Error("expected original file transcript entry");
    }
    const rolledBackMtime = new Date(Math.max(1, original.mtimeMs - 60_000));
    await fs.utimes(original.filePath, rolledBackMtime, rolledBackMtime);
    const restoredEntry = await buildSessionEntry(original.filePath);
    if (!restoredEntry) {
      throw new Error("expected restored file transcript entry");
    }
    expect(restoredEntry.hash).toBe(originalEntry.hash);

    const harness = new SessionStartupCatchupHarness(
      [
        {
          path: originalEntry.path,
          hash: originalEntry.hash,
          mtime: original.mtimeMs,
          size: original.size,
        },
      ],
      true,
    );

    await expect(harness.catchUp()).resolves.toEqual([original.filePath]);
    await harness.waitForSessionSync();
    expect(harness.indexedPaths).toEqual([]);
    expect(harness.getIndexedSourceState(originalEntry.path)).toEqual({
      path: originalEntry.path,
      hash: originalEntry.hash,
      mtime: restoredEntry.mtimeMs,
      size: restoredEntry.size,
    });
    expect(harness.getSourceMetadataUpdateCount()).toBe(1);

    const restarted = harness.restartForStartup();
    await expect(restarted.catchUp()).resolves.toEqual([]);
    expect(restarted.syncCalls).toEqual([]);
    expect(restarted.indexedPaths).toEqual([]);
  });

  it("indexes a SQLite transcript whose updatedAt rolled back", async () => {
    const session = await writeSqliteSession({
      content: "SQLite rollback",
      updatedAt: 10,
    });
    const state = statSessionEntrySync(session.sessionKey, {
      agentId: "main",
      sessionId: session.sessionId,
      storePath: session.storePath,
      sessionKey: session.sessionKey,
      updatedAtMs: 10,
    });
    if (!state) {
      throw new Error("expected SQLite transcript state");
    }
    const harness = new SessionStartupCatchupHarness(
      [
        {
          path: state.path,
          hash: "previous-hash",
          mtime: 20,
          size: state.size,
        },
      ],
      true,
    );

    await expect(harness.catchUp()).resolves.toEqual([session.sessionKey]);
    await harness.waitForSessionSync();

    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(harness.indexedPaths).toEqual([session.corpusPath]);
    expect(harness.indexedContents).toEqual(["User: SQLite rollback"]);
  });

  it("converges an unchanged SQLite updatedAt rollback after deferred session sync", async () => {
    const session = await writeSqliteSession({ updatedAt: 10 });
    const entry = await buildSessionEntry(session.sessionKey, {
      agentId: "main",
      sessionId: session.sessionId,
      storePath: session.storePath,
      sessionKey: session.sessionKey,
      updatedAtMs: 10,
      sessionKind: "interactive",
    });
    if (!entry) {
      throw new Error("expected SQLite transcript entry");
    }
    const harness = new SessionStartupCatchupHarness(
      [
        {
          path: entry.path,
          hash: entry.hash,
          mtime: 20,
          size: entry.size,
        },
      ],
      true,
      false,
      true,
    );

    await expect(harness.catchUp()).resolves.toEqual([session.sessionKey]);
    await harness.waitForSessionSync();

    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
    expect(harness.indexedPaths).toEqual([]);
    expect(harness.indexedContents).toEqual([]);
    expect(harness.getIndexedSourceState(entry.path)).toEqual({
      path: entry.path,
      hash: entry.hash,
      mtime: entry.mtimeMs,
      size: entry.size,
    });
    expect(harness.getSourceMetadataUpdateCount()).toBe(1);

    const restarted = harness.restartForStartup();
    await expect(restarted.catchUp()).resolves.toEqual([]);
    expect(restarted.syncCalls).toEqual([]);
    expect(restarted.indexedPaths).toEqual([]);
    await restarted.runArchiveSyncForTest();
    expect(restarted.getSourceMetadataUpdateCount()).toBe(1);
  });

  it("does not fall back to full session sync when identity targets normalize away", async () => {
    await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);

    await harness.runSyncForTest({
      reason: "queued-sessions",
      sessions: [{ agentId: "other", sessionId: "thread" }],
    });

    expect(harness.indexedPaths).toEqual([]);
  });

  it("does not fall back to full session sync for malformed identity session ids", async () => {
    await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);

    await harness.runSyncForTest({
      reason: "queued-sessions",
      sessions: [{ agentId: "main", sessionId: "bad/nested" }],
    });

    expect(harness.indexedPaths).toEqual([]);
  });

  it("skips corpus preflight when an ordinary sync has no session work", async () => {
    const harness = new SessionStartupCatchupHarness([]);

    await harness.runSyncForTest({ reason: "session-delta" });

    expect(harness.corpusListCalls).toBe(0);
  });

  it("resolves identity-targeted updates through a custom session store", async () => {
    const storePath = path.join(stateDir, "custom-sessions", "sessions.json");
    const session = await writeSqliteSession({
      storePath,
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
      content: "custom store target",
    });
    const harness = new SessionStartupCatchupHarness([]);
    harness.addPendingSessionTarget({
      agentId: "main",
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
    });

    await harness.processPendingSessionUpdates();
    await Promise.resolve();

    expect(harness.getDirtyArchiveFiles()).toEqual([session.sessionKey]);
    expect(harness.syncCalls[0]?.archiveFiles).toEqual([session.sessionKey]);
    expect(harness.syncCalls[0]?.sessions).toHaveLength(1);
  });

  it("keeps targeted indexing on the SQLite store resolved by its corpus snapshot", async () => {
    const session = await writeSqliteSession({
      storePath: path.join(stateDir, "custom-sessions", "sessions.json"),
      sessionId: "snapshot-thread",
      sessionKey: "agent:main:chat:snapshot",
      content: "original snapshot target",
    });
    const replacement = await writeSqliteSession({
      storePath: path.join(stateDir, "replacement-sessions", "sessions.json"),
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      content: "replacement store target",
    });
    await configureTestSessionStore(session.storePath);
    const harness = new SessionStartupCatchupHarness([]);
    harness.afterNextCorpusListForTest(async () => {
      await configureTestSessionStore(replacement.storePath);
    });

    await harness.runSyncForTest({
      reason: "queued-sessions",
      sessions: [
        {
          agentId: "main",
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
        },
      ],
    });

    expect(harness.corpusListCalls).toBe(1);
    expect(harness.indexedPaths).toEqual([session.corpusPath]);
    expect(harness.indexedContents[0]).toContain("original snapshot target");
    expect(harness.indexedContents[0]).not.toContain("replacement store target");
  });

  it("preserves generated-session classification during targeted custom-store indexing", async () => {
    const storePath = path.join(stateDir, "custom-sessions", "sessions.json");
    const session = await writeSqliteSession({
      storePath,
      sessionId: "cron-thread",
      sessionKey: "agent:main:cron:job-1:run:run-1",
      role: "assistant",
      content: "Internal cron output that must stay out.",
    });
    const harness = new SessionStartupCatchupHarness([]);

    await harness.runSyncForTest({
      reason: "targeted-generated-session",
      sessions: [
        {
          agentId: "main",
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
        },
      ],
    });

    expect(harness.indexedPaths).toEqual([session.corpusPath]);
    expect(harness.indexedContents).toEqual([""]);
  });

  it("queues transcript update identity without requiring a session file", async () => {
    vi.useFakeTimers();
    const harness = new SessionStartupCatchupHarness([]);
    harness.startTranscriptListener();

    try {
      emitSessionTranscriptUpdate({
        target: {
          agentId: "main",
          sessionId: "thread",
          sessionKey: "agent:main:thread",
        },
      });

      expect(harness.getPendingSessionTargets()).toEqual([
        { agentId: "main", sessionId: "thread", sessionKey: "agent:main:thread" },
      ]);
    } finally {
      harness.stopTranscriptListener();
    }
  });

  it("indexes a persisted SQLite append through the real transcript listener", async () => {
    vi.useFakeTimers();
    const session = await writeSqliteSession();
    const harness = new SessionStartupCatchupHarness([], true, true);
    harness.startTranscriptListener();

    try {
      await appendSessionTranscriptMessageByIdentity({
        agentId: "main",
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        storePath: session.storePath,
        cwd: stateDir,
        message: { role: "assistant", content: "persisted listener update" },
      });
      await publishSessionTranscriptUpdateByIdentity(session);

      await vi.advanceTimersByTimeAsync(6000);
      await harness.waitForSessionSync();

      expect(harness.indexedPaths).toEqual([session.corpusPath]);
      expect(harness.indexedContents).toEqual([
        "User: startup catchup\nAssistant: persisted listener update",
      ]);
    } finally {
      harness.stopTranscriptListener();
    }
  });

  it("indexes a real SQLite delete archive through the transcript listener", async () => {
    vi.useFakeTimers();
    const session = await writeSqliteSession({ content: "lifecycle archive memory" });
    const harness = new SessionStartupCatchupHarness([], true, true);
    harness.startTranscriptListener();

    try {
      await expect(
        deleteSessionEntry({
          agentId: "main",
          archiveTranscript: true,
          expectedSessionId: session.sessionId,
          sessionKey: session.sessionKey,
          storePath: session.storePath,
        }),
      ).resolves.toBe(true);
      await harness.waitForCorpusList();
      expect(harness.getPendingArchiveFiles()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(6000);
      await harness.waitForSessionSync();

      expect(harness.indexedPaths).toHaveLength(1);
      expect(harness.indexedPaths[0]).toMatch(
        /^sessions\/main\/thread\.jsonl\.deleted\..+(?:\.zst)?$/,
      );
      expect(harness.indexedContents).toEqual(["User: lifecycle archive memory"]);
    } finally {
      harness.stopTranscriptListener();
    }
  });

  it("ignores live file notifications without an identity target", async () => {
    vi.useFakeTimers();
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);
    harness.startTranscriptListener();

    emitSessionTranscriptUpdate({
      sessionFile: session.filePath,
      sessionKey: "agent:main:thread",
    });
    await harness.waitForCorpusList();

    expect(harness.getPendingArchiveFiles()).toEqual([]);
    expect(harness.getPendingSessionTargets()).toEqual([]);
    harness.stopTranscriptListener();
  });

  it.each(["reset", "deleted"] as const)(
    "indexes a %s archive through the live listener debounce path",
    async (reason) => {
      vi.useFakeTimers();
      const session = await writeSessionFile(`thread.jsonl.${reason}.2026-06-23T10-00-00.000Z`);
      const harness = new SessionStartupCatchupHarness([], true);
      harness.startTranscriptListener();

      try {
        emitSessionTranscriptUpdate({ sessionFile: session.filePath });
        await harness.waitForCorpusList();

        expect(harness.getPendingArchiveFiles()).toEqual([session.filePath]);

        await vi.advanceTimersByTimeAsync(6000);
        await harness.waitForSessionSync();

        expect(harness.getDirtyArchiveFiles()).toEqual([session.filePath]);
        expect(harness.syncCalls[0]?.archiveFiles).toEqual([session.filePath]);
        expect(harness.indexedPaths).toEqual([
          `sessions/main/thread.jsonl.${reason}.2026-06-23T10-00-00.000Z`,
        ]);
        expect(harness.indexedContents).toEqual(["User: startup catchup"]);
      } finally {
        harness.stopTranscriptListener();
      }
    },
  );

  it.each([
    "thread.jsonl.bak.2026-06-23T10-00-00.000Z",
    "thread.trajectory.jsonl",
    "sessions.json",
  ])("ignores non-corpus session artifact updates for %s", async (fileName) => {
    vi.useFakeTimers();
    const session = await writeSessionFile(fileName);
    const harness = new SessionStartupCatchupHarness([], true);
    harness.startTranscriptListener();

    try {
      emitSessionTranscriptUpdate({ sessionFile: session.filePath });
      await harness.waitForCorpusList();
      await vi.advanceTimersByTimeAsync(6000);
      await harness.waitForSessionSync();

      expect(harness.getPendingArchiveFiles()).toEqual([]);
      expect(harness.getDirtyArchiveFiles()).toEqual([]);
      expect(harness.syncCalls).toEqual([]);
      expect(harness.indexedPaths).toEqual([]);
    } finally {
      harness.stopTranscriptListener();
    }
  });

  it("ignores archive notifications missing from the corpus", async () => {
    vi.useFakeTimers();
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const missingPath = path.join(sessionsDir, "missing.jsonl.reset.2026-06-23T10-00-00.000Z");
    const harness = new SessionStartupCatchupHarness([], true);
    harness.startTranscriptListener();

    try {
      emitSessionTranscriptUpdate({ sessionFile: missingPath });
      await harness.waitForCorpusList();
      await vi.advanceTimersByTimeAsync(6000);
      await harness.waitForSessionSync();

      expect(harness.getDirtyArchiveFiles()).toEqual([]);
      expect(harness.syncCalls).toEqual([]);
      expect(harness.indexedPaths).toEqual([]);
    } finally {
      harness.stopTranscriptListener();
    }
  });
});
