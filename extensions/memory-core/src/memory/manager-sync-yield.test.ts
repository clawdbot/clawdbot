// Memory Core tests cover manager sync yield plugin behavior.
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
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

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-qmd")>();
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
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: vi.fn(),
}));

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
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected db = createDbMock();

  readonly indexedPaths: string[] = [];

  constructor(private readonly onIndexFile: (count: number) => void) {
    super();
  }

  async syncTargetArchiveFiles(files: string[]): Promise<void> {
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
  protected override db: DatabaseSync;

  constructor(db: DatabaseSync) {
    super(() => {});
    this.db = db;
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
      path.join(sessionsDir, `session-${index}.jsonl`),
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
      for (let index = 0; index < 1_001; index += 1) {
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
        rows: 1_000,
      });
      expect(countCacheRows(targetDb)).toBe(1_001);
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  });
});
