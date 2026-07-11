// Memory Core tests cover manager sync yield plugin behavior.
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => {
  const basename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;
  return {
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
