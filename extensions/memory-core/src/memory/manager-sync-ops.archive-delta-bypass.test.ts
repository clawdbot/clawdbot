import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySource,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  forceSessions?: boolean;
  sessionFile?: string;
  progress?: (update: MemorySyncProgressUpdate) => void;
};

class SessionDeltaHarness extends MemoryManagerSyncOps {
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
  protected db = null as unknown as DatabaseSync;

  readonly syncCalls: SyncParams[] = [];

  addPendingSessionFile(sessionFile: string) {
    this.sessionPendingFiles.add(sessionFile);
  }

  getDirtySessionFiles(): string[] {
    return Array.from(this.sessionsDirtyFiles);
  }

  isSessionsDirty(): boolean {
    return this.sessionsDirty;
  }

  async processPendingSessionDeltas(): Promise<void> {
    await (
      this as unknown as {
        processSessionDeltaBatch: () => Promise<void>;
      }
    ).processSessionDeltaBatch();
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

describe("session archive delta bypass", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-delta-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSessionFile(name: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "short archived session" },
      }) + "\n",
      "utf-8",
    );
    return filePath;
  }

  it.each(["reset", "deleted"] as const)(
    "marks below-threshold %s archives dirty immediately",
    async (reason) => {
      const archivePath = await writeSessionFile(
        `session-a.jsonl.${reason}.2026-05-03T05-38-59.000Z`,
      );
      const harness = new SessionDeltaHarness();
      harness.addPendingSessionFile(archivePath);

      await harness.processPendingSessionDeltas();

      expect(harness.getDirtySessionFiles()).toEqual([archivePath]);
      expect(harness.isSessionsDirty()).toBe(true);
      expect(harness.syncCalls).toEqual([{ reason: "session-delta" }]);
    },
  );

  it("keeps .jsonl.bak archives on the normal below-threshold delta path", async () => {
    const bakPath = await writeSessionFile("session-a.jsonl.bak.2026-05-03T05-38-59.000Z");
    const harness = new SessionDeltaHarness();
    harness.addPendingSessionFile(bakPath);

    await harness.processPendingSessionDeltas();

    expect(harness.getDirtySessionFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });

  it("keeps live transcripts below the configured thresholds", async () => {
    const livePath = await writeSessionFile("session-a.jsonl");
    const harness = new SessionDeltaHarness();
    harness.addPendingSessionFile(livePath);

    await harness.processPendingSessionDeltas();

    expect(harness.getDirtySessionFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });
});
