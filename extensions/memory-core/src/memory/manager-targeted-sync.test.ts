// Memory Core tests cover manager targeted sync plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  clearMemorySyncedSessionFiles,
  markMemoryTargetSessionFilesDirty,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

describe("memory targeted session sync", () => {
  it("preserves unrelated dirty sessions after targeted cleanup", () => {
    const secondSessionPath = "/tmp/targeted-dirty-second.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/targeted-dirty-first.jsonl", secondSessionPath]);

    const sessionsDirty = clearMemorySyncedSessionFiles({
      sessionsDirtyFiles,
      targetSessionFiles: ["/tmp/targeted-dirty-first.jsonl"],
    });

    expect(sessionsDirtyFiles.has(secondSessionPath)).toBe(true);
    expect(sessionsDirty).toBe(true);
  });

  it("marks target sessions dirty while identity sync is paused", () => {
    const targetSessionPath = "/tmp/paused-target.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/other-dirty.jsonl"]);

    const sessionsDirty = markMemoryTargetSessionFilesDirty({
      sessionsDirtyFiles,
      targetSessionFiles: [targetSessionPath],
    });

    expect(sessionsDirty).toBe(true);
    expect(sessionsDirtyFiles.has(targetSessionPath)).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it("leaves targeted sessions dirty after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const syncSessionFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error("embedding backend failed"))
      .mockResolvedValueOnce(undefined);
    const sessionsDirtyFiles = new Set(["/tmp/targeted-fallback.jsonl", "/tmp/other-dirty.jsonl"]);

    const result = await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetSessionFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      reason: "post-compaction",
      progress: undefined,
      sessionsDirtyFiles,
      syncSessionFiles,
      shouldFallbackOnError: () => true,
      activateFallbackProvider,
    });

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(syncSessionFiles).toHaveBeenCalledTimes(1);
    expect(syncSessionFiles).toHaveBeenCalledWith({
      needsFullReindex: false,
      targetSessionFiles: ["/tmp/targeted-fallback.jsonl"],
      progress: undefined,
    });
    expect(result).toEqual({ handled: true, sessionsDirty: true });
    expect(sessionsDirtyFiles.has("/tmp/targeted-fallback.jsonl")).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });
});
