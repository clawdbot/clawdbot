import { describe, expect, it } from "vitest";
import { resolveSessionBoundaryPromptCacheKey } from "./session-boundary-prompt-cache-key.js";

describe("resolveSessionBoundaryPromptCacheKey", () => {
  it("is stable within a lifecycle window and changes across reset or compaction boundaries", () => {
    const resolve = (boundaryCount: number) =>
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount,
        sessionId: "session-1",
      });

    expect([resolve(0), resolve(0), resolve(1), resolve(2)]).toEqual([
      "session-1:0",
      "session-1:0",
      "session-1:1",
      "session-1:2",
    ]);
  });

  it("preserves an explicit caller cache key", () => {
    expect(
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount: 4,
        promptCacheKey: "caller-key",
        sessionId: "session-1",
      }),
    ).toBe("caller-key");
  });

  it("keeps long Unicode derived keys distinct across boundaries within the 64-char limit", () => {
    const longSessionId = `internal-session-effects-${"🦞".repeat(64)}`;
    const keys = [0, 1, 2].map((boundaryCount) =>
      resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount,
        sessionId: longSessionId,
      }),
    );

    expect(new Set(keys).size).toBe(keys.length);
    for (const [boundaryCount, key] of keys.entries()) {
      expect(key).toBeDefined();
      expect(Array.from(key ?? "").length).toBeLessThanOrEqual(64);
      expect(key?.endsWith(`:${boundaryCount}`)).toBe(true);
    }
  });
});
