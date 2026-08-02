// Memory Core tests cover manager targeted sync plugin behavior.
import type {
  MemorySessionSyncTarget,
  MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { enqueueMemoryTargetedSessionSync } from "./manager-sync-control.js";
import {
  markMemoryTargetArchiveFilesDirty,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

describe("memory targeted session sync", () => {
  it("marks target sessions dirty while identity sync is paused", () => {
    const targetSessionPath = "/tmp/paused-target.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/other-dirty.jsonl"]);

    const sessionsDirty = markMemoryTargetArchiveFilesDirty({
      sessionsDirtyFiles,
      targetArchiveFiles: [targetSessionPath],
    });

    expect(sessionsDirty).toBe(true);
    expect(sessionsDirtyFiles.has(targetSessionPath)).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it("leaves targeted sessions dirty after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const syncArchiveFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error("embedding backend failed"))
      .mockResolvedValueOnce(undefined);
    const sessionsDirtyFiles = new Set(["/tmp/targeted-fallback.jsonl", "/tmp/other-dirty.jsonl"]);

    const result = await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetArchiveFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      reason: "post-compaction",
      progress: undefined,
      sessionsDirtyFiles,
      syncArchiveFiles,
      shouldFallbackOnError: () => true,
      activateFallbackProvider,
    });

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(syncArchiveFiles).toHaveBeenCalledTimes(1);
    expect(syncArchiveFiles).toHaveBeenCalledWith({
      needsFullReindex: false,
      targetArchiveFiles: ["/tmp/targeted-fallback.jsonl"],
      progress: undefined,
    });
    expect(result).toEqual({ handled: true, sessionsDirty: true });
    expect(sessionsDirtyFiles.has("/tmp/targeted-fallback.jsonl")).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it("preserves the full-retry dirty marker after targeted cleanup", async () => {
    const syncArchiveFiles = vi.fn(async () => undefined);
    const sessionsDirtyFiles = new Set(["/tmp/targeted-full-retry.jsonl"]);

    const result = await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetArchiveFiles: new Set(["/tmp/targeted-full-retry.jsonl"]),
      reason: "post-compaction",
      progress: undefined,
      sessionsFullRetryDirty: true,
      sessionsDirtyFiles,
      syncArchiveFiles,
      shouldFallbackOnError: () => false,
      activateFallbackProvider: async () => false,
    });

    expect(result).toEqual({ handled: true, sessionsDirty: true });
    expect(sessionsDirtyFiles.size).toBe(0);
  });

  it("queues identity session targets while a sync is already running", async () => {
    let resolveSyncing: (() => void) | undefined;
    const syncing = new Promise<void>((resolve) => {
      resolveSyncing = resolve;
    });
    const queuedArchiveFiles = new Set<string>();
    const queuedSessions = new Map<string, MemorySessionSyncTarget>();
    let queuedForce = false;
    const queuedProgressCallbacks = new Set<NonNullable<MemorySyncParams["progress"]>>();
    let queuedSessionSync: Promise<void> | null = null;
    const progressUpdate = { completed: 1, total: 2, label: "queued" };
    const progress = vi.fn();
    const sync = vi.fn(async (params?: MemorySyncParams) => {
      params?.progress?.(progressUpdate);
    });

    const queued = enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => false,
        getSyncing: () => syncing,
        getQueuedArchiveFiles: () => queuedArchiveFiles,
        getQueuedSessions: () => queuedSessions,
        getQueuedForce: () => queuedForce,
        setQueuedForce: (value) => {
          queuedForce = value;
        },
        getQueuedProgressCallbacks: () => queuedProgressCallbacks,
        getQueuedSessionSync: () => queuedSessionSync,
        setQueuedSessionSync: (value) => {
          queuedSessionSync = value;
        },
        sync,
      },
      {
        sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
        force: true,
        progress,
      },
    );

    resolveSyncing?.();
    await queued;

    expect(sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      force: true,
      sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      archiveFiles: [],
      progress: expect.any(Function),
    });
    expect(progress).toHaveBeenCalledWith(progressUpdate);
  });

  it("keeps failed queued targets for a later retry", async () => {
    let resolveSyncing: (() => void) | undefined;
    const syncing = new Promise<void>((resolve) => {
      resolveSyncing = resolve;
    });
    let rejectQueuedSync: ((error: Error) => void) | undefined;
    const queuedSync = new Promise<void>((_resolve, reject) => {
      rejectQueuedSync = reject;
    });
    const queuedArchiveFiles = new Set<string>();
    const queuedSessions = new Map<string, MemorySessionSyncTarget>();
    let queuedForce = false;
    const queuedProgressCallbacks = new Set<NonNullable<MemorySyncParams["progress"]>>();
    let queuedSessionSync: Promise<void> | null = null;
    const sync = vi.fn().mockReturnValueOnce(queuedSync).mockResolvedValueOnce(undefined);
    const state = {
      isClosed: () => false,
      getSyncing: () => syncing,
      getQueuedArchiveFiles: () => queuedArchiveFiles,
      getQueuedSessions: () => queuedSessions,
      getQueuedForce: () => queuedForce,
      setQueuedForce: (value: boolean) => {
        queuedForce = value;
      },
      getQueuedProgressCallbacks: () => queuedProgressCallbacks,
      getQueuedSessionSync: () => queuedSessionSync,
      setQueuedSessionSync: (value: Promise<void> | null) => {
        queuedSessionSync = value;
      },
      sync,
    };

    const firstProgress = vi.fn();
    const first = enqueueMemoryTargetedSessionSync(state, {
      sessions: [{ agentId: "main", sessionId: "first", sessionKey: "agent:main:first" }],
      archiveFiles: ["/tmp/first.jsonl"],
      force: true,
      progress: firstProgress,
    });
    const firstRejection = expect(first).rejects.toThrow("transient sqlite failure");

    resolveSyncing?.();
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledTimes(1);
    });

    const concurrentProgress = vi.fn();
    const concurrent = enqueueMemoryTargetedSessionSync(state, {
      sessions: [{ agentId: "main", sessionId: "second", sessionKey: "agent:main:second" }],
      archiveFiles: ["/tmp/second.jsonl"],
      progress: concurrentProgress,
    });
    expect(concurrent).toBe(first);

    rejectQueuedSync?.(new Error("transient sqlite failure"));
    await firstRejection;

    expect(queuedArchiveFiles).toEqual(new Set(["/tmp/second.jsonl", "/tmp/first.jsonl"]));
    expect(Array.from(queuedSessions.values())).toEqual([
      { agentId: "main", sessionId: "second", sessionKey: "agent:main:second" },
      { agentId: "main", sessionId: "first", sessionKey: "agent:main:first" },
    ]);
    expect(queuedSessionSync).toBeNull();
    expect(queuedProgressCallbacks.size).toBe(0);
    expect(queuedForce).toBe(true);

    await enqueueMemoryTargetedSessionSync(state);

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({
      reason: "queued-sessions",
      force: true,
      sessions: [
        { agentId: "main", sessionId: "second", sessionKey: "agent:main:second" },
        { agentId: "main", sessionId: "first", sessionKey: "agent:main:first" },
      ],
      archiveFiles: ["/tmp/second.jsonl", "/tmp/first.jsonl"],
    });
    expect(queuedArchiveFiles.size).toBe(0);
    expect(queuedSessions.size).toBe(0);
    expect(queuedSessionSync).toBeNull();
    expect(queuedForce).toBe(false);
  });

  it("clears queued state when the manager closes while the queue waits", async () => {
    let resolveSyncing: (() => void) | undefined;
    const syncing = new Promise<void>((resolve) => {
      resolveSyncing = resolve;
    });
    let closed = false;
    const queuedArchiveFiles = new Set(["/tmp/close-retained.jsonl"]);
    const queuedSessions = new Map<string, MemorySessionSyncTarget>();
    let queuedForce = false;
    const queuedProgressCallbacks = new Set<NonNullable<MemorySyncParams["progress"]>>();
    let queuedSessionSync: Promise<void> | null = null;
    const sync = vi.fn(async () => undefined);
    const progress = vi.fn();

    const queued = enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => closed,
        getSyncing: () => syncing,
        getQueuedArchiveFiles: () => queuedArchiveFiles,
        getQueuedSessions: () => queuedSessions,
        getQueuedForce: () => queuedForce,
        setQueuedForce: (value) => {
          queuedForce = value;
        },
        getQueuedProgressCallbacks: () => queuedProgressCallbacks,
        getQueuedSessionSync: () => queuedSessionSync,
        setQueuedSessionSync: (value) => {
          queuedSessionSync = value;
        },
        sync,
      },
      {
        sessions: [{ agentId: "main", sessionId: "close", sessionKey: "agent:main:close" }],
        force: true,
        progress,
      },
    );

    closed = true;
    resolveSyncing?.();
    await queued;

    expect(sync).not.toHaveBeenCalled();
    expect(queuedArchiveFiles.size).toBe(0);
    expect(queuedSessions.size).toBe(0);
    expect(queuedProgressCallbacks.size).toBe(0);
    expect(queuedForce).toBe(false);
    expect(queuedSessionSync).toBeNull();
  });
});
