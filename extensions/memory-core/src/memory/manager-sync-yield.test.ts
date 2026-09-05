// Memory Core tests cover manager sync yield plugin behavior.
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { SessionTranscriptCorpusEntry } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildSessionEntryMock } = vi.hoisted(() => ({
  buildSessionEntryMock: vi.fn(),
}));
const originalSyncYieldStateDir = process.env.OPENCLAW_STATE_DIR;

function setSyncYieldStateDir(): void {
  Reflect.set(
    process.env,
    "OPENCLAW_STATE_DIR",
    path.join(os.tmpdir(), "openclaw-session-sync-yield"),
  );
}

function restoreSyncYieldStateDir(): void {
  if (originalSyncYieldStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalSyncYieldStateDir);
  }
}

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    Agent: vi.fn(),
    EnvHttpProxyAgent: vi.fn(),
    ProxyAgent: vi.fn(),
    fetch: vi.fn(),
    getGlobalDispatcher: vi.fn(),
    setGlobalDispatcher: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-sessions")>();
  const basename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;
  return {
    ...actual,
    buildSessionEntry: buildSessionEntryMock,
    isSessionArchiveArtifactName: (fileName: string) => /\.jsonl\.(reset|deleted)\./.test(fileName),
    isUsageCountedSessionTranscriptFileName: (fileName: string) => fileName.endsWith(".jsonl"),
    listSessionTranscriptCorpusEntriesForAgent: vi.fn(async () => []),
    parseCanonicalSessionSyncTargetFromPath: (filePath: string) => ({
      agentId: "main",
      sessionId: basename(filePath).replace(/\.jsonl$/, ""),
    }),
    sessionPathForFile: (filePath: string) => `sessions/${basename(filePath)}`,
    sessionPathForSessionIdentity: (agentId: string, sessionId: string) =>
      `sessions/${agentId}/${sessionId}`,
  };
});

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: vi.fn(),
}));

import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

function createDb(): DatabaseSync {
  const { DatabaseSync: NodeDatabaseSync } = requireNodeSqlite();
  const db = new NodeDatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    cacheEnabled: true,
    ftsEnabled: false,
    ftsTokenizer: "unicode61",
  });
  return db;
}

class SessionSyncYieldHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    sync: {
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    },
  } as ResolvedMemorySearchConfig;
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

  readonly indexedPaths: string[] = [];
  private corpusFiles: string[] = [];

  constructor(
    db: DatabaseSync,
    private readonly onIndexFile: (count: number) => void,
  ) {
    super();
    this.publishedDatabase = new MemoryIndexDatabase(db);
  }

  async syncTargetArchiveFiles(files: string[]): Promise<void> {
    this.corpusFiles = files;
    await this.syncArchiveFiles({
      needsFullReindex: false,
      targetArchiveFiles: files,
    });
  }

  protected override async listSessionCorpusEntries(): Promise<SessionTranscriptCorpusEntry[]> {
    return this.corpusFiles.map((sessionFile, index) => ({
      agentId: this.agentId,
      artifactKind: "archive-artifact",
      sessionFile,
      sessionId: `session-${index}`,
    }));
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected async sync(): Promise<void> {}

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

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(
    entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {
    this.indexedPaths.push(entry.path);
    this.onIndexFile(this.indexedPaths.length);
  }
}

class EmbeddingCacheSeedHarness extends SessionSyncYieldHarness {
  protected override readonly cache = { enabled: true };

  constructor(db: DatabaseSync) {
    super(db, () => {});
  }

  async seedCache(sourceDb: DatabaseSync): Promise<void> {
    await this.seedEmbeddingCache(sourceDb);
  }
}

describe("session sync responsiveness", () => {
  beforeEach(() => {
    setSyncYieldStateDir();
    buildSessionEntryMock.mockImplementation(async (absPath: string) => {
      const name = path.basename(absPath);
      return {
        path: `sessions/${name}`,
        absPath,
        mtimeMs: 1,
        size: 1,
        hash: `hash-${name}`,
        content: `user message for ${name}`,
      };
    });
  });

  afterEach(() => {
    restoreSyncYieldStateDir();
    vi.clearAllMocks();
  });

  it("yields to the event loop between session file batches", async () => {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const files = Array.from({ length: 11 }, (_value, index) =>
      path.join(sessionsDir, `session-${index}.jsonl.deleted.2026-07-11T00-00-00.000Z`),
    );
    let immediateRan = false;
    const immediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        immediateRan = true;
        resolve();
      });
    });
    const observedBeforeLastFile: boolean[] = [];
    const db = createDb();
    const harness = new SessionSyncYieldHarness(db, (count) => {
      if (count === 11) {
        observedBeforeLastFile.push(immediateRan);
      }
    });

    try {
      await harness.syncTargetArchiveFiles(files);
      expect(harness.indexedPaths).toHaveLength(files.length);
      expect(observedBeforeLastFile).toEqual([true]);
      await immediate;
    } finally {
      db.close();
    }
  });
});

describe("embedding cache seed responsiveness", () => {
  function countCacheRows(db: DatabaseSync): number {
    const row = db.prepare("SELECT count(*) AS count FROM memory_embedding_cache").get() as {
      count: number;
    };
    return row.count;
  }

  it("commits each materialized page before yielding", async () => {
    const sourceDb = createDb();
    const targetDb = createDb();
    const { StatementSync } = requireNodeSqlite();
    const prepare = vi.spyOn(targetDb, "prepare");
    const columns = vi.spyOn(StatementSync.prototype, "columns");
    try {
      const insert = sourceDb.prepare(
        `INSERT INTO memory_embedding_cache
           (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const rawLargeEmbedding = ` ${JSON.stringify(Array.from({ length: 4096 }, () => 0.1234567890123456))}\n`;
      sourceDb.exec("BEGIN");
      for (let index = 0; index < 101; index += 1) {
        insert.run(
          "test",
          "model",
          "key",
          `hash-${index}`,
          index === 0 ? " malformed JSON \n" : index === 1 ? rawLargeEmbedding : "[ 0.5 ]",
          index === 0 ? null : index === 1 ? 4096 : 1,
          index - 1,
        );
      }
      sourceDb.exec("COMMIT");

      let duringYield: {
        sourceInTransaction: boolean;
        targetInTransaction: boolean;
        rows: number;
      } | null = null;
      const observedYield = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          try {
            duringYield = {
              sourceInTransaction: sourceDb.isTransaction,
              targetInTransaction: targetDb.isTransaction,
              rows: countCacheRows(targetDb),
            };
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      await new EmbeddingCacheSeedHarness(targetDb).seedCache(sourceDb);
      await observedYield;

      expect(duringYield).toEqual({
        sourceInTransaction: false,
        targetInTransaction: false,
        rows: 100,
      });
      expect(countCacheRows(targetDb)).toBe(101);
      expect(prepare.mock.calls.filter(([sql]) => /^insert/i.test(sql))).toHaveLength(1);
      expect(columns).not.toHaveBeenCalled();
      const readCache = (db: DatabaseSync) =>
        db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all();
      expect(readCache(targetDb)).toEqual(readCache(sourceDb));
    } finally {
      prepare.mockRestore();
      columns.mockRestore();
      sourceDb.close();
      targetDb.close();
    }
  });
});
