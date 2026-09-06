import { describe, expect, it } from "vitest";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";

describe("clampOpenAIPromptCacheKey", () => {
  it.each([
    ["absent", undefined],
    ["short", "session-1"],
    ["at the cap", "a".repeat(64)],
    ["over the cap", "a".repeat(65)],
    ["astral within the code-point cap", "🦞".repeat(40)],
    ["astral over the cap", "🦞".repeat(74)],
    ["cut inside a grapheme", "👨‍👩‍👧‍👦".repeat(20)],
    ["lone surrogate at the boundary", "a".repeat(63) + "\ud83dtail"],
  ] as const)("preserves the 64-code-point contract: %s", (_name, key) => {
    expect(clampOpenAIPromptCacheKey(key)).toBe(
      key === undefined ? undefined : Array.from(key).slice(0, 64).join(""),
    );
  });
});
