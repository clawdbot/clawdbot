// Covers outbound thread/topic id normalization for strings, numbers, and empty
// route values.
import { describe, expect, it } from "vitest";
import { normalizeOutboundThreadId } from "./thread-id.js";

describe("normalizeOutboundThreadId", () => {
  it.each([
    { input: undefined, expected: undefined },
    { input: null, expected: undefined },
    { input: "   ", expected: undefined },
    { input: 123.9, expected: "123" },
    { input: " 456 ", expected: "456" },
    { input: Number.NaN, expected: undefined },
    { input: Number.POSITIVE_INFINITY, expected: undefined },
  ])("normalizes outbound thread id for %j", ({ input, expected }) => {
    expect(normalizeOutboundThreadId(input)).toBe(expected);
  });
});
