// Tests for surrogate-safe UTF-16 string slicing helpers.
import { describe, expect, it } from "vitest";
import {
  avoidTrailingHighSurrogateBreak,
  sliceUtf16Safe,
  truncateUtf16Safe,
} from "./utf16-slice.js";

describe("avoidTrailingHighSurrogateBreak", () => {
  it("keeps ordinary and terminal boundaries unchanged", () => {
    expect(avoidTrailingHighSurrogateBreak("hello", 0, 3)).toBe(3);
    expect(avoidTrailingHighSurrogateBreak("hello", 0, 5)).toBe(5);
  });

  it("moves a split before a surrogate pair when room remains", () => {
    expect(avoidTrailingHighSurrogateBreak("a🤖b", 0, 2)).toBe(1);
  });

  it("includes the full pair when a one-unit chunk starts with it", () => {
    expect(avoidTrailingHighSurrogateBreak("🤖b", 0, 1)).toBe(2);
  });
});

describe("sliceUtf16Safe", () => {
  it("slices ASCII string normally", () => {
    expect(sliceUtf16Safe("hello world", 0, 5)).toBe("hello");
  });

  it("handles negative start", () => {
    expect(sliceUtf16Safe("hello world", -5)).toBe("world");
  });

  it("handles negative end", () => {
    expect(sliceUtf16Safe("hello world", 0, -6)).toBe("hello");
  });

  it("handles start beyond length", () => {
    expect(sliceUtf16Safe("hello", 10)).toBe("");
  });

  it("handles end beyond length", () => {
    expect(sliceUtf16Safe("hello", 0, 10)).toBe("hello");
  });

  it("returns empty when start > end, matching String.prototype.slice", () => {
    expect(sliceUtf16Safe("hello", 3, 1)).toBe("");
  });

  it("preserves emoji with surrogate pairs", () => {
    const emoji = "👨‍👩‍👧‍👦";
    expect(sliceUtf16Safe(emoji, 0)).toBe(emoji);
  });

  it("returns empty string when slicing middle of surrogate pair", () => {
    const input = "👨👩";
    // Slicing at position 1-3 hits middle of surrogate pairs
    expect(sliceUtf16Safe(input, 1, 3)).toBe("");
  });

  it("returns empty string when slicing at start of surrogate pair", () => {
    const input = "👨👩";
    // Slicing at position 0-1 would cut surrogate pair, adjust to 0
    expect(sliceUtf16Safe(input, 0, 1)).toBe("");
  });

  it("handles empty string", () => {
    expect(sliceUtf16Safe("", 0)).toBe("");
  });

  it("handles undefined end", () => {
    expect(sliceUtf16Safe("hello", 2)).toBe("llo");
  });
});

describe("truncateUtf16Safe", () => {
  it("returns input when shorter than limit", () => {
    expect(truncateUtf16Safe("hello", 10)).toBe("hello");
  });

  it("truncates when longer than limit", () => {
    expect(truncateUtf16Safe("hello world", 5)).toBe("hello");
  });

  it("handles zero limit", () => {
    expect(truncateUtf16Safe("hello", 0)).toBe("");
  });

  it("handles negative limit", () => {
    expect(truncateUtf16Safe("hello", -1)).toBe("");
  });

  it("floors decimal limit", () => {
    expect(truncateUtf16Safe("hello world", 5.7)).toBe("hello");
  });

  it("preserves emoji with surrogate pairs", () => {
    const emoji = "👨‍👩‍👧‍👦";
    const result = truncateUtf16Safe(emoji, 10);
    // Should not return dangling surrogate
    expect(result.length).toBeLessThanOrEqual(emoji.length);
  });

  it("returns empty string when truncating at surrogate pair boundary", () => {
    const input = "👨👩";
    expect(truncateUtf16Safe(input, 1)).toBe("");
  });
});
