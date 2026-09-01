import { describe, expect, it } from "vitest";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "./utf8-truncate.js";

describe("UTF-8 byte truncation", () => {
  it.each([
    { value: "abcé", maxBytes: 4, expected: "abc" },
    { value: "abc✓", maxBytes: 5, expected: "abc" },
    { value: "abc😀", maxBytes: 6, expected: "abc" },
    { value: "😀", maxBytes: 4, expected: "😀" },
  ])("keeps a valid prefix for $value at $maxBytes bytes", ({ value, maxBytes, expected }) => {
    const result = truncateUtf8Prefix(value, maxBytes);

    expect(result).toBe(expected);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
    expect(result).not.toContain("�");
  });

  it.each([
    { value: "éabc", maxBytes: 4, expected: "abc" },
    { value: "✓abc", maxBytes: 5, expected: "abc" },
    { value: "😀abc", maxBytes: 6, expected: "abc" },
    { value: "😀", maxBytes: 4, expected: "😀" },
  ])("keeps a valid suffix for $value at $maxBytes bytes", ({ value, maxBytes, expected }) => {
    const result = truncateUtf8Suffix(value, maxBytes);

    expect(result).toBe(expected);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
    expect(result).not.toContain("�");
  });

  it("returns an empty string for a non-positive limit", () => {
    expect(truncateUtf8Prefix("value", 0)).toBe("");
    expect(truncateUtf8Suffix("value", -1)).toBe("");
  });
});
