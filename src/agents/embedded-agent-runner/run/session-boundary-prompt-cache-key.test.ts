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

    expect(resolve(0)).toBe(resolve(0));
    expect(resolve(1)).not.toBe(resolve(0));
    expect(resolve(2)).not.toBe(resolve(1));
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

  it("clamps derived keys from long internal session ids to OpenAI's 64-char limit", () => {
    const longSessionId = `internal-session-effects-session-companion-${"a".repeat(50)}`;
    const key = resolveSessionBoundaryPromptCacheKey({
      api: "openai-responses",
      boundaryCount: 0,
      sessionId: longSessionId,
    });
    expect(key).toBeDefined();
    expect(Array.from(key ?? "").length).toBeLessThanOrEqual(64);
    expect(key?.startsWith("internal-session-effects-session-companion-")).toBe(true);
  });
});
