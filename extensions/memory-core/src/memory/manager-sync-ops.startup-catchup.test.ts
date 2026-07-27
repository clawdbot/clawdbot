// Memory Core tests cover manager sync ops.startup catchup plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { statSessionEntrySync } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type {
  MemorySource,
  MemorySyncParams,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
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

type SourceStateRow = { path: string; hash: string; mtime: number; size: number };
type StartupCatchupHarnessInternals = {
  syncArchiveFiles(params: { needsFullReindex: boolean }): Promise<void>;
  updateSessionDelta(sessionFile: string): Promise<{
    pendingBytes: number;
    pendingLines: number;
    pendingMessages: number;
  }>;
};

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
  private pendingSyncWork: Promise<void> = Promise.resolve();

  constructor(
    sourceRows: SourceStateRow[],
    private readonly indexSessionUpdates = false,
  ) {
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

  async runSyncForTest(params?: MemorySyncParams): Promise<void> {
    await this.runSync(params);
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

  async processPendingSessionDeltas(): Promise<void> {
    await (
      this as unknown as {
        processSessionDeltaBatch: () => Promise<void>;
      }
    ).processSessionDeltaBatch();
  }

  async waitForSessionSync(): Promise<void> {
    await this.pendingSyncWork;
  }

  async combineTargetArchiveFilesForTest(params: {
    sessions?: MemorySyncParams["sessions"];
    archiveFiles?: string[];
  }): Promise<Set<string> | null> {
    return await (
      this as unknown as {
        combineTargetArchiveFiles: (params: {
          sessions?: MemorySyncParams["sessions"];
          archiveFiles?: string[];
        }) => Promise<Set<string> | null>;
      }
    ).combineTargetArchiveFiles(params);
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

  protected async sync(params?: MemorySyncParams): Promise<void> {
    this.syncCalls.push(params ?? {});
    this.pendingSyncWork = this.indexSessionUpdates
      ? this.syncArchiveFiles({ needsFullReindex: false }).then(() => undefined)
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
    closeOpenClawAgentDatabasesForTest();
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
    marker: string;
    storePath: string;
    sessionId: string;
    sessionKey: string;
    corpusPath: string;
  }> {
    const storePath =
      params.storePath ?? path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionId = params.sessionId ?? "thread";
    const sessionKey = params.sessionKey ?? `agent:main:chat:${sessionId}`;
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await configureTestSessionStore(storePath);
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionFile: marker,
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
      marker,
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

    await expect(harness.catchUp()).resolves.toEqual([session.marker]);
    expect(harness.getDirtyArchiveFiles()).toEqual([session.marker]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
  });

  it("schedules a full retry when invalidated sessions no longer exist", async () => {
    const harness = new SessionStartupCatchupHarness([]);
    harness.markFullSessionRetry();

    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
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
      await (harness as unknown as StartupCatchupHarnessInternals).syncArchiveFiles({
        needsFullReindex: true,
      });
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

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([session.marker]);
    expect(harness.getDirtyArchiveFiles()).toEqual([session.marker]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([]);
  });

  it("leaves unchanged indexed SQLite sessions clean during startup catch-up", async () => {
    const session = await writeSqliteSession({ updatedAt: 10 });
    const state = statSessionEntrySync(session.marker, {
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
    expect(harness.getDirtyArchiveFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });

  it.each([
    {
      name: "read",
      fileName: "delta-read.jsonl",
      failOn: "read" as const,
      code: "EWOULDBLOCK",
    },
    {
      name: "open",
      fileName: "delta-open.jsonl",
      failOn: "open" as const,
      code: "EAGAIN",
    },
  ])("retries transient session transcript $name failures during delta updates", async (params) => {
    const session = await writeSessionFile(params.fileName);
    const harness = new SessionStartupCatchupHarness([]);
    let attempts = 0;
    const sessionBuffer = await fs.readFile(session.filePath);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const [target] = args;
        if (
          params.failOn === "open" &&
          typeof target === "string" &&
          path.resolve(target) === session.filePath &&
          attempts++ === 0
        ) {
          const err = new Error(
            "Unknown system error -11: Unknown system error -11, open",
          ) as NodeJS.ErrnoException;
          err.code = params.code;
          err.errno = -11;
          throw err;
        }

        return {
          read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            if (params.failOn === "read" && attempts++ === 0) {
              const err = new Error(
                "Unknown system error -11: Unknown system error -11, read",
              ) as NodeJS.ErrnoException;
              err.code = params.code;
              err.errno = -11;
              throw err;
            }
            const start = position ?? 0;
            const chunk = sessionBuffer.subarray(start, start + length);
            chunk.copy(buffer, offset);
            return { bytesRead: chunk.length, buffer };
          },
          close: async () => {},
        } as unknown as Awaited<ReturnType<typeof fs.open>>;
      });

    try {
      const delta = await (harness as unknown as StartupCatchupHarnessInternals).updateSessionDelta(
        session.filePath,
      );
      expect(delta).toMatchObject({
        pendingBytes: session.size,
        pendingMessages: 1,
      });
      expect(attempts).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
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

  it("resolves identity-targeted delta sync through a custom session store", async () => {
    const storePath = path.join(stateDir, "custom-sessions", "sessions.json");
    const session = await writeSqliteSession({
      storePath,
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
      content: "custom store target",
    });
    const harness = new SessionStartupCatchupHarness([]);
    (harness as unknown as { settings: ResolvedMemorySearchConfig }).settings.sync.sessions = {
      deltaBytes: 1,
      deltaMessages: 1,
      postCompactionForce: true,
    };
    harness.addPendingSessionTarget({
      agentId: "main",
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
    });

    await harness.processPendingSessionDeltas();
    await Promise.resolve();

    expect(harness.getDirtyArchiveFiles()).toEqual([session.marker]);
    expect(harness.syncCalls).toEqual([{ reason: "session-delta" }]);
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
    await writeSqliteSession({
      storePath,
      sessionId: "other-thread",
      sessionKey: "agent:main:chat:other",
      content: "Other custom-store content",
    });
    const harness = new SessionStartupCatchupHarness([]);

    await (
      harness as unknown as {
        syncArchiveFiles: (params: {
          needsFullReindex: boolean;
          targetArchiveFiles: string[];
        }) => Promise<void>;
      }
    ).syncArchiveFiles({
      needsFullReindex: false,
      targetArchiveFiles: [session.marker],
    });

    expect(harness.indexedPaths).toEqual([session.corpusPath]);
    expect(harness.indexedContents).toEqual([""]);
  });

  it("keeps targeted SQLite corpus markers during archive-file sync", async () => {
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const configPath = path.join(stateDir, "openclaw.json");
    const sessionId = "sqlite-target";
    const sessionKey = "agent:main:chat:sqlite-target";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      cwd: stateDir,
      message: { role: "user", content: "sqlite targeted memory content" },
    });
    await fs.writeFile(configPath, JSON.stringify({ session: { store: storePath } }), "utf-8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const harness = new SessionStartupCatchupHarness([]);

    await (
      harness as unknown as {
        syncArchiveFiles: (params: {
          needsFullReindex: boolean;
          targetArchiveFiles: string[];
        }) => Promise<void>;
      }
    ).syncArchiveFiles({
      needsFullReindex: false,
      targetArchiveFiles: [marker],
    });

    expect(harness.indexedPaths).toEqual(["sessions/main/sqlite-target.jsonl"]);
    expect(harness.indexedContents[0]).toContain("sqlite targeted memory content");
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

  it("keeps canonical path transcript update compatibility", async () => {
    vi.useFakeTimers();
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);
    harness.startTranscriptListener();

    emitSessionTranscriptUpdate({
      sessionFile: session.filePath,
      sessionKey: "agent:main:thread",
    });

    expect(harness.getPendingArchiveFiles()).toEqual([session.filePath]);
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

        expect(harness.getPendingArchiveFiles()).toEqual([session.filePath]);

        await vi.advanceTimersByTimeAsync(6000);
        await harness.waitForSessionSync();

        expect(harness.getDirtyArchiveFiles()).toEqual([session.filePath]);
        expect(harness.syncCalls).toEqual([{ reason: "session-delta" }]);
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

  it("leaves a missing archive update unindexed", async () => {
    vi.useFakeTimers();
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const missingPath = path.join(sessionsDir, "missing.jsonl.reset.2026-06-23T10-00-00.000Z");
    const harness = new SessionStartupCatchupHarness([], true);
    harness.startTranscriptListener();

    try {
      emitSessionTranscriptUpdate({ sessionFile: missingPath });
      await vi.advanceTimersByTimeAsync(6000);
      await harness.waitForSessionSync();

      expect(harness.getDirtyArchiveFiles()).toEqual([missingPath]);
      expect(harness.syncCalls).toEqual([{ reason: "session-delta" }]);
      expect(harness.indexedPaths).toEqual([]);
    } finally {
      harness.stopTranscriptListener();
    }
  });
});
