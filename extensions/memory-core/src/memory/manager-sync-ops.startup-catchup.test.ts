import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySource,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  sessionFiles?: string[];
  progress?: (update: MemorySyncProgressUpdate) => void;
};

type SourceStateRow = { path: string; hash: string; mtime: number; size: number };

class SessionStartupCatchupHarness extends MemoryManagerSyncOps {
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
  protected db: DatabaseSync;

  readonly syncCalls: SyncParams[] = [];

  constructor(sourceRows: SourceStateRow[]) {
    super();
    this.sources.add("sessions");
    this.db = {
      prepare: () => ({
        all: () => sourceRows,
        get: () => undefined,
        run: () => undefined,
      }),
    } as unknown as DatabaseSync;
  }

  async catchUp(): Promise<string[]> {
    return await this.runSessionStartupCatchup();
  }

  async markStartupDirtyFiles(): Promise<string[]> {
    return await this.markSessionStartupCatchupDirtyFiles();
  }

  getDirtySessionFiles(): string[] {
    return Array.from(this.sessionsDirtyFiles);
  }

  isSessionsDirty(): boolean {
    return this.sessionsDirty;
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected async sync(params?: SyncParams): Promise<void> {
    this.syncCalls.push(params ?? {});
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

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected async indexFile(
    _entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {}
}

describe("session startup catch-up", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-startup-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function writeSessionFile(
    name: string,
  ): Promise<{ filePath: string; size: number; mtimeMs: number }> {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, name);
    await fs.writeFile(
      filePath,
      JSON.stringify({ type: "message", message: { role: "user", content: "startup catchup" } }) +
        "\n",
      "utf-8",
    );
    const stat = await fs.stat(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  it("marks stale indexed session files dirty and schedules catch-up sync", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([
      {
        path: "sessions/main/thread.jsonl",
        hash: "old-hash",
        mtime: session.mtimeMs - 1000,
        size: session.size,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([session.filePath]);
    expect(harness.getDirtySessionFiles()).toEqual([session.filePath]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
  });

  it("can mark startup catch-up files without scheduling background sync", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([
      {
        path: "sessions/main/thread.jsonl",
        hash: "old-hash",
        mtime: session.mtimeMs - 1000,
        size: session.size,
      },
    ]);

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([session.filePath]);
    expect(harness.getDirtySessionFiles()).toEqual([session.filePath]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([]);
  });

  it("leaves unchanged indexed session files clean", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([
      {
        path: "sessions/main/thread.jsonl",
        hash: "current-hash",
        mtime: session.mtimeMs,
        size: session.size,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.getDirtySessionFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });
});
