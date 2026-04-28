import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabaseAtPath } from "./manager-db.js";
import {
  _createMemorySyncControlConfigForTests,
  enqueueMemoryTargetedSessionSync,
  runMemorySyncWithReadonlyRecovery,
  type MemoryReadonlyRecoveryState,
} from "./manager-sync-control.js";

type ReadonlyRecoveryHarness = MemoryReadonlyRecoveryState & {
  syncing: Promise<void> | null;
  queuedSessionFiles: Set<string>;
  queuedSessionSync: Promise<void> | null;
  vectorDegradedWriteWarningShown: boolean;
  ensureProviderInitialized: ReturnType<typeof vi.fn>;
  enqueueTargetedSessionSync: ReturnType<typeof vi.fn>;
  runSync: ReturnType<typeof vi.fn>;
  openDatabase: ReturnType<typeof vi.fn>;
  closeDatabase: ReturnType<typeof vi.fn>;
  resetVectorState: ReturnType<typeof vi.fn>;
  ensureSchema: ReturnType<typeof vi.fn>;
  readMeta: ReturnType<typeof vi.fn>;
};

describe("memory manager readonly recovery", () => {
  let workspaceDir = "";
  let indexPath = "";

  function createQueuedSyncHarness(syncing: Promise<void>) {
    const queuedSessionFiles = new Set<string>();
    let queuedSessionSync: Promise<void> | null = null;
    const sync = vi.fn(async () => {});
    return {
      queuedSessionFiles,
      get queuedSessionSync() {
        return queuedSessionSync;
      },
      sync,
      state: {
        isClosed: () => false,
        getSyncing: () => syncing,
        getQueuedSessionFiles: () => queuedSessionFiles,
        getQueuedSessionSync: () => queuedSessionSync,
        setQueuedSessionSync: (value: Promise<void> | null) => {
          queuedSessionSync = value;
        },
        sync,
      },
    };
  }

  function _createMemoryConfig(): OpenClawConfig {
    return _createMemorySyncControlConfigForTests(workspaceDir, indexPath);
  }

  function createReadonlyRecoveryHarness() {
    const reopenedClose = vi.fn();
    const initialClose = vi.fn();
    const reopenedDb = { close: reopenedClose } as unknown as DatabaseSync;
    const initialDb = { close: initialClose } as unknown as DatabaseSync;
    const harness: ReadonlyRecoveryHarness = {
      closed: false,
      syncing: null,
      queuedSessionFiles: new Set<string>(),
      queuedSessionSync: null,
      db: initialDb,
      vector: {
        dims: 123,
      },
      vectorDegradedWriteWarningShown: true,
      readonlyRecoveryAttempts: 0,
      readonlyRecoverySuccesses: 0,
      readonlyRecoveryFailures: 0,
      readonlyRecoveryLastError: undefined,
      ensureProviderInitialized: vi.fn(async () => {}),
      enqueueTargetedSessionSync: vi.fn(async () => {}),
      runSync: vi.fn(async (_params) => undefined) as ReadonlyRecoveryHarness["runSync"],
      openDatabase: vi.fn(() => reopenedDb),
      closeDatabase: vi.fn((db: DatabaseSync) => {
        db.close();
      }),
      resetVectorState: vi.fn(function (this: ReadonlyRecoveryHarness) {
        this.vector.dims = undefined;
        this.vectorDegradedWriteWarningShown = false;
      }) as ReadonlyRecoveryHarness["resetVectorState"],
      ensureSchema: vi.fn(() => undefined) as ReadonlyRecoveryHarness["ensureSchema"],
      readMeta: vi.fn(() => undefined),
    };
    return {
      harness,
      initialDb,
      initialClose,
      reopenedDb,
      reopenedClose,
    };
  }

  async function runSyncWithReadonlyRecovery(
    harness: ReadonlyRecoveryHarness,
    params?: { reason?: string; force?: boolean; sessionFiles?: string[] },
  ) {
    return await runMemorySyncWithReadonlyRecovery(harness, params);
  }

  function expectReadonlyRecoveryStatus(
    instance: {
      readonlyRecoveryAttempts: number;
      readonlyRecoverySuccesses: number;
      readonlyRecoveryFailures: number;
      readonlyRecoveryLastError?: string;
    },
    lastError: string,
  ) {
    expect({
      attempts: instance.readonlyRecoveryAttempts,
      successes: instance.readonlyRecoverySuccesses,
      failures: instance.readonlyRecoveryFailures,
      lastError: instance.readonlyRecoveryLastError,
    }).toEqual({
      attempts: 1,
      successes: 1,
      failures: 0,
      lastError,
    });
  }

  async function expectReadonlyRetry(params: { firstError: unknown; expectedLastError: string }) {
    const { harness, initialClose } = createReadonlyRecoveryHarness();
    harness.runSync.mockRejectedValueOnce(params.firstError).mockResolvedValueOnce(undefined);

    await runSyncWithReadonlyRecovery(harness, {
      reason: "test",
    });

    expect(harness.runSync).toHaveBeenCalledTimes(2);
    expect(harness.openDatabase).toHaveBeenCalledTimes(1);
    expect(harness.resetVectorState).toHaveBeenCalledTimes(1);
    expect(harness.vector.dims).toBe(123);
    expect(initialClose).toHaveBeenCalledTimes(1);
    expectReadonlyRecoveryStatus(harness, params.expectedLastError);
  }

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-readonly-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("reopens sqlite and retries once when sync hits SQLITE_READONLY", async () => {
    await expectReadonlyRetry({
      firstError: new Error("attempt to write a readonly database"),
      expectedLastError: "attempt to write a readonly database",
    });
  });

  it("reopens sqlite and retries when readonly appears in error code", async () => {
    await expectReadonlyRetry({
      firstError: { message: "write failed", code: "SQLITE_READONLY" },
      expectedLastError: "write failed",
    });
  });

  it("does not retry non-readonly sync errors", async () => {
    const { harness, initialClose } = createReadonlyRecoveryHarness();
    harness.runSync.mockRejectedValueOnce(new Error("embedding timeout"));

    await expect(
      runSyncWithReadonlyRecovery(harness, {
        reason: "test",
      }),
    ).rejects.toThrow("embedding timeout");
    expect(harness.runSync).toHaveBeenCalledTimes(1);
    expect(harness.openDatabase).not.toHaveBeenCalled();
    expect(harness.resetVectorState).not.toHaveBeenCalled();
    expect(initialClose).not.toHaveBeenCalled();
  });

  it("clears the degraded warning latch before retrying", async () => {
    const { harness } = createReadonlyRecoveryHarness();
    harness.runSync.mockRejectedValueOnce(new Error("attempt to write a readonly database"));

    await expect(
      runSyncWithReadonlyRecovery(harness, {
        reason: "test",
      }),
    ).resolves.toBeUndefined();

    expect(harness.vectorDegradedWriteWarningShown).toBe(false);
  });

  it("prefers reopened vector dims when metadata is available", async () => {
    const { harness } = createReadonlyRecoveryHarness();
    harness.readMeta.mockReturnValueOnce({ vectorDims: 768 });
    harness.runSync.mockRejectedValueOnce(new Error("attempt to write a readonly database"));

    await expect(
      runSyncWithReadonlyRecovery(harness, {
        reason: "test",
      }),
    ).resolves.toBeUndefined();

    expect(harness.vector.dims).toBe(768);
  });

  it("sets busy_timeout on memory sqlite connections", async () => {
    const db = openMemoryDatabaseAtPath(indexPath, false);
    const row = db.prepare("PRAGMA busy_timeout").get() as
      | { busy_timeout?: number; timeout?: number }
      | undefined;
    const busyTimeout = row?.busy_timeout ?? row?.timeout;
    expect(busyTimeout).toBe(5000);
    db.close();
  });

  it("queues targeted session files behind an in-flight sync", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const harness = createQueuedSyncHarness(pendingSync);

    const queued = enqueueMemoryTargetedSessionSync(harness.state, [
      "  /tmp/first.jsonl ",
      "",
      "/tmp/second.jsonl",
    ]);

    expect(harness.sync).not.toHaveBeenCalled();

    releaseSync();
    await queued;

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-session-files",
      sessionFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl"],
    });
    expect(harness.queuedSessionSync).toBeNull();
  });

  it("merges repeated queued requests while the active sync is still running", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const harness = createQueuedSyncHarness(pendingSync);

    const first = enqueueMemoryTargetedSessionSync(harness.state, [
      "/tmp/first.jsonl",
      "/tmp/second.jsonl",
    ]);
    const second = enqueueMemoryTargetedSessionSync(harness.state, [
      "/tmp/second.jsonl",
      "/tmp/third.jsonl",
    ]);

    expect(first).toBe(second);

    releaseSync();
    await second;

    expect(harness.sync).toHaveBeenCalledTimes(1);
    expect(harness.sync).toHaveBeenCalledWith({
      reason: "queued-session-files",
      sessionFiles: ["/tmp/first.jsonl", "/tmp/second.jsonl", "/tmp/third.jsonl"],
    });
  });

  it("falls back to the active sync when no usable session files were queued", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const harness = createQueuedSyncHarness(pendingSync);

    const queued = enqueueMemoryTargetedSessionSync(harness.state, ["", "   "]);

    expect(queued).toBe(pendingSync);
    releaseSync();
    await queued;
    expect(harness.sync).not.toHaveBeenCalled();
  });
});
