// Memory Core tests cover manager sync yield plugin behavior.
import fs from "node:fs/promises";
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
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";

const { buildSessionEntryMock } = vi.hoisted(() => ({
  buildSessionEntryMock: vi.fn(),
}));
let syncYieldStateDir = "";

async function setSyncYieldStateDir(): Promise<void> {
  syncYieldStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-sync-yield-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", syncYieldStateDir);
  await configureMemoryCoreDreamingStateForTests();
}

async function restoreSyncYieldStateDir(): Promise<void> {
  resetPluginStateStoreForTests();
  resetMemoryCoreDreamingStateForTests();
  vi.unstubAllEnvs();
  await fs.rm(syncYieldStateDir, { recursive: true, force: true });
  syncYieldStateDir = "";
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
    listSessionFilesForAgent: vi.fn(async () => []),
    listSessionTranscriptCorpusEntriesForAgent: vi.fn(async () => []),
    parseCanonicalSessionSyncTargetFromPath: (filePath: string) => ({
      agentId: "main",
      sessionId: basename(filePath).replace(/\.jsonl$/, ""),
    }),
    resolveSessionFileForSyncTarget: (target: { agentId?: string; sessionId: string }) => ({
      agentId: target.agentId ?? "main",
      sessionFile: `/tmp/${target.sessionId}.jsonl`,
      sessionId: target.sessionId,
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

function createDbMock(): DatabaseSync {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  } as unknown as DatabaseSync;
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
  protected publishedDatabase = new MemoryIndexDatabase(createDbMock());

  readonly indexedPaths: string[] = [];
  private corpusFiles: string[] = [];

  constructor(private readonly onIndexFile: (count: number) => void) {
    super();
  }

  async syncTargetArchiveFiles(files: string[]): Promise<void> {
    this.corpusFiles = files;
    await (
      this as unknown as {
        syncArchiveFiles: (params: {
          needsFullReindex: boolean;
          targetArchiveFiles: string[];
        }) => Promise<void>;
      }
    ).syncArchiveFiles({
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
    super(() => {});
    this.publishedDatabase = new MemoryIndexDatabase(db);
  }

  async seedCache(sourceDb: DatabaseSync): Promise<void> {
    await this.seedEmbeddingCache(sourceDb);
  }

  async replaceCache(sourceDb: DatabaseSync, expectedRevision: number): Promise<boolean> {
    return await this.replaceEmbeddingCacheFrom(sourceDb, expectedRevision);
  }
}

describe("session sync responsiveness", () => {
  beforeEach(async () => {
    await setSyncYieldStateDir();
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

  afterEach(async () => {
    await restoreSyncYieldStateDir();
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
    const harness = new SessionSyncYieldHarness((count) => {
      if (count === 11) {
        observedBeforeLastFile.push(immediateRan);
      }
    });

    await harness.syncTargetArchiveFiles(files);

    expect(harness.indexedPaths).toHaveLength(files.length);
    expect(observedBeforeLastFile).toEqual([true]);
    await immediate;
  });
});

describe("embedding cache seed responsiveness", () => {
  const { DatabaseSync: NodeDatabaseSync } = requireNodeSqlite();

  beforeEach(async () => {
    await setSyncYieldStateDir();
  });

  afterEach(async () => {
    await restoreSyncYieldStateDir();
    vi.clearAllMocks();
  });

  function createCacheDb(): DatabaseSync {
    const db = new NodeDatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    return db;
  }

  function countCacheRows(db: DatabaseSync): number {
    const row = db.prepare("SELECT count(*) AS count FROM memory_embedding_cache").get() as {
      count: number;
    };
    return row.count;
  }

  it("commits each materialized page before yielding", async () => {
    const sourceDb = createCacheDb();
    const targetDb = createCacheDb();
    try {
      const insert = sourceDb.prepare(
        `INSERT INTO memory_embedding_cache
           (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      sourceDb.exec("BEGIN");
      for (let index = 0; index < 101; index += 1) {
        insert.run("test", "model", "key", `hash-${index}`, "[0.5]", 1, index);
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
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  });

  it("replaces the published cache in committed pages between event-loop yields", async () => {
    const sourceDb = createCacheDb();
    const targetDb = createCacheDb();
    try {
      const insert = (db: DatabaseSync, prefix: string) => {
        const statement = db.prepare(
          `INSERT INTO memory_embedding_cache
             (provider, model, provider_key, hash, embedding, dims, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        db.exec("BEGIN");
        for (let index = 0; index < 101; index += 1) {
          statement.run("test", "model", "key", `${prefix}-${index}`, "[0.5]", 1, index);
        }
        db.exec("COMMIT");
      };
      insert(sourceDb, "source");
      insert(targetDb, "target");

      let observed: { inTransaction: boolean; rows: number } | undefined;
      let observation: Promise<void> | undefined;
      targetDb.function("observe_cache_delete", () => {
        if (!observation) {
          observation = new Promise<void>((resolve) => {
            setImmediate(() => {
              observed = {
                inTransaction: targetDb.isTransaction,
                rows: countCacheRows(targetDb),
              };
              resolve();
            });
          });
        }
        return null;
      });
      targetDb.exec(`
        CREATE TEMP TRIGGER observe_cache_delete
        BEFORE DELETE ON memory_embedding_cache
        BEGIN SELECT observe_cache_delete(); END
      `);

      const revision = (
        targetDb.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
          revision: number;
        }
      ).revision;
      await expect(
        new EmbeddingCacheSeedHarness(targetDb).replaceCache(sourceDb, revision),
      ).resolves.toBe(true);
      await observation;

      expect(observed?.inTransaction).toBe(false);
      expect(observed?.rows).toBeGreaterThan(0);
      expect(observed?.rows).toBeLessThan(101);
      expect(countCacheRows(targetDb)).toBe(101);
      expect(
        targetDb
          .prepare(
            "SELECT COUNT(*) AS count FROM memory_embedding_cache WHERE hash LIKE 'source-%'",
          )
          .get(),
      ).toEqual({ count: 101 });
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  });

  it("stops cache publication when the canonical index revision changes", async () => {
    const sourceDb = createCacheDb();
    const targetDb = createCacheDb();
    try {
      const insert = targetDb.prepare(
        `INSERT INTO memory_embedding_cache
           (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES ('test', 'model', 'key', ?, '[0.5]', 1, ?)`,
      );
      targetDb.exec("BEGIN");
      for (let index = 0; index < 101; index += 1) {
        insert.run(`target-${index}`, index);
      }
      targetDb.exec("COMMIT");
      sourceDb
        .prepare(
          `INSERT INTO memory_embedding_cache
             (provider, model, provider_key, hash, embedding, dims, updated_at)
           VALUES ('test', 'model', 'key', 'stale-shadow', '[0.5]', 1, 1)`,
        )
        .run();
      let revisionAdvanced = false;
      targetDb.function("advance_index_revision", () => {
        if (!revisionAdvanced) {
          revisionAdvanced = true;
          setImmediate(() => {
            targetDb.exec("UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1");
          });
        }
        return null;
      });
      targetDb.exec(`
        CREATE TEMP TRIGGER advance_index_revision
        BEFORE DELETE ON memory_embedding_cache
        BEGIN SELECT advance_index_revision(); END
      `);
      const revision = (
        targetDb.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
          revision: number;
        }
      ).revision;

      await expect(
        new EmbeddingCacheSeedHarness(targetDb).replaceCache(sourceDb, revision),
      ).resolves.toBe(false);
      expect(countCacheRows(targetDb)).toBeGreaterThan(0);
      expect(countCacheRows(targetDb)).toBeLessThan(101);
      expect(
        targetDb
          .prepare("SELECT hash FROM memory_embedding_cache WHERE hash = 'stale-shadow'")
          .get(),
      ).toBeUndefined();
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  });
});
