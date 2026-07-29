// Memory Core tests cover manager targeted sync plugin behavior.
import type { MemorySessionSyncTarget } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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
    let queuedSessionSync: Promise<void> | null = null;
    const sync = vi.fn(async () => {});

    const queued = enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => false,
        getSyncing: () => syncing,
        getQueuedArchiveFiles: () => queuedArchiveFiles,
        getQueuedSessions: () => queuedSessions,
        getQueuedSessionSync: () => queuedSessionSync,
        setQueuedSessionSync: (value) => {
          queuedSessionSync = value;
        },
        sync,
      },
      {
        sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      },
    );

    resolveSyncing?.();
    await queued;

    expect(sync).toHaveBeenCalledWith({
      reason: "queued-sessions",
      sessions: [{ agentId: "main", sessionId: "targeted", sessionKey: "agent:main:targeted" }],
      archiveFiles: [],
    });
  });
});
