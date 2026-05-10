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

vi.mock("undici", () => ({
  Agent: vi.fn(),
  EnvHttpProxyAgent: vi.fn(),
  ProxyAgent: vi.fn(),
  fetch: vi.fn(),
  getGlobalDispatcher: vi.fn(),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => {
  const basename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;
  return {
    buildSessionEntry: buildSessionEntryMock,
    isSessionArchiveArtifactName: (fileName: string) => /\.jsonl\.(reset|deleted)\./.test(fileName),
    isUsageCountedSessionTranscriptFileName: (fileName: string) => fileName.endsWith(".jsonl"),
    listSessionFilesForAgent: vi.fn(async () => []),
    sessionPathForFile: (filePath: string) => `sessions/${basename(filePath)}`,
  };
});

vi.mock("./embeddings.js", () => ({
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
  protected db = createDbMock();

  readonly indexedPaths: string[] = [];

  constructor(private readonly onIndexFile: (count: number) => void) {
    super();
  }

  async syncTargetSessionFiles(files: string[]): Promise<void> {
    await (
      this as unknown as {
        syncSessionFiles: (params: {
          needsFullReindex: boolean;
          targetSessionFiles: string[];
        }) => Promise<void>;
      }
    ).syncSessionFiles({
      needsFullReindex: false,
      targetSessionFiles: files,
    });
  }

  protected computeProviderKey(): string {
    return "test";
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
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(os.tmpdir(), "openclaw-session-sync-yield"));
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
    vi.unstubAllEnvs();
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

    await harness.syncTargetSessionFiles(files);

    expect(harness.indexedPaths).toHaveLength(files.length);
    expect(observedBeforeLastFile).toEqual([true]);
    await immediate;
  });
});
