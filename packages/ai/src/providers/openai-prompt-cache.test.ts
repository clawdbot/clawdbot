// Prompt cache key tests pin the unit the 64-character cap counts in.
import { describe, expect, it } from "vitest";
import {
  clampOpenAIPromptCacheKey,
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from "./openai-prompt-cache.js";

describe("clampOpenAIPromptCacheKey", () => {
  it("passes an undefined or short key through", () => {
    expect(clampOpenAIPromptCacheKey(undefined)).toBeUndefined();
    expect(clampOpenAIPromptCacheKey("session-1")).toBe("session-1");
  });

  it("keeps a key that is exactly at the cap", () => {
    const key = "a".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
    expect(clampOpenAIPromptCacheKey(key)).toBe(key);
  });

  // A UTF-16 cap would halve this key and end it on a lone surrogate, which the
  // provider rejects; the dual in session-boundary-prompt-cache-key pins the same limit.
  it("counts and cuts astral characters whole", () => {
    const key = "🦞".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH + 10);
    const clamped = clampOpenAIPromptCacheKey(key);
    expect(clamped).toBe("🦞".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH));
    expect(Array.from(clamped ?? "")).toHaveLength(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
  });

  it("keeps an astral key whose UTF-16 length exceeds the cap", () => {
    const key = "🦞".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH / 2);
    expect(key.length).toBe(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
    expect(clampOpenAIPromptCacheKey(key)).toBe(key);
  });
});
