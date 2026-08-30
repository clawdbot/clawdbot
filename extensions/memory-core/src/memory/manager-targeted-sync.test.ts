// Memory Core tests cover manager targeted sync plugin behavior.
import { describe, expect, it, vi } from "vitest";
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
    // The activated fallback is reported so the sync owner can rebuild the
    // index under the new provider; this path returns before its handler.
    expect(result).toEqual({ handled: true, sessionsDirty: true, fallbackActivated: true });
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

    expect(result).toEqual({ handled: true, sessionsDirty: true, fallbackActivated: false });
    expect(sessionsDirtyFiles.size).toBe(0);
  });

  it("preserves source reconciliation after targeted cleanup", async () => {
    const sessionsDirtyFiles = new Set(["/tmp/targeted-reconcile.jsonl"]);

    const result = await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetArchiveFiles: new Set(["/tmp/targeted-reconcile.jsonl"]),
      reason: "post-compaction",
      sessionsReconcileDirty: true,
      sessionsDirtyFiles,
      syncArchiveFiles: async () => undefined,
      shouldFallbackOnError: () => false,
      activateFallbackProvider: async () => false,
    });

    expect(result).toEqual({ handled: true, sessionsDirty: true, fallbackActivated: false });
    expect(sessionsDirtyFiles.size).toBe(0);
  });
});
