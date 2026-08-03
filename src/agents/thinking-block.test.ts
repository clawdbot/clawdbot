// Tests for thinking block detection.
import { describe, expect, it } from "vitest";
import { isThinkingLikeBlock } from "./thinking-block.js";

describe("isThinkingLikeBlock", () => {
  it("returns true for thinking type", () => {
    expect(isThinkingLikeBlock({ type: "thinking" })).toBe(true);
  });

  it("returns true for redacted_thinking type", () => {
    expect(isThinkingLikeBlock({ type: "redacted_thinking" })).toBe(true);
  });

  it("returns false for non-thinking type", () => {
    expect(isThinkingLikeBlock({ type: "text" })).toBe(false);
  });

  it("returns false for missing type field", () => {
    expect(isThinkingLikeBlock({ content: "hello" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isThinkingLikeBlock(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isThinkingLikeBlock(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isThinkingLikeBlock("thinking")).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isThinkingLikeBlock({})).toBe(false);
  });
});
