import { describe, expect, it } from "vitest";
import {
  createUtf8PrefixTruncator,
  truncateUtf8Prefix,
  truncateUtf8Suffix,
} from "./utf8-truncate.js";

describe("UTF-8 byte truncation", () => {
  it.each([
    { value: "abcé", maxBytes: 4, expected: "abc" },
    { value: "abc✓", maxBytes: 5, expected: "abc" },
    { value: "abc😀", maxBytes: 6, expected: "abc" },
    { value: "abc😀", maxBytes: 4, expected: "abc" },
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
    expect(createUtf8PrefixTruncator("value", -1)(-1)).toBe("");
    expect(createUtf8PrefixTruncator("value", 0)(0)).toBe("");
  });

  it("keeps prepared prefix reads independent across limits", () => {
    const value = "a🌍\ud800z";
    const prefix = createUtf8PrefixTruncator(value, 9);
    expect([0, 1, 4, 5, 8, 9, 1].map(prefix)).toEqual(["", "a", "a", "a🌍", "a🌍�", value, "a"]);
  });

  it.each([
    { value: "abc😀", maxBytes: 4.5, prefix: "abc�", suffix: "c😀" },
    { value: "\ud800x", maxBytes: 4, prefix: "\ud800x", suffix: "\ud800x" },
    { value: "\ud800x", maxBytes: 3, prefix: "�", suffix: "x" },
    { value: "\ud800x", maxBytes: Number.NaN, prefix: "", suffix: "�x" },
    { value: "\udc00", maxBytes: Infinity, prefix: "\udc00", suffix: "\udc00" },
    { value: "aj", maxBytes: 2 ** -52, prefix: "", suffix: "j" },
    { value: "éj", maxBytes: 2 ** -52, prefix: "", suffix: "" },
    { value: "abcdefghij", maxBytes: 1 + 2 ** -51, prefix: "a", suffix: "j" },
  ])(
    "preserves conversion and fractional limits for $value at $maxBytes bytes",
    ({ value, maxBytes, prefix, suffix }) => {
      expect(truncateUtf8Prefix(value, maxBytes)).toBe(prefix);
      expect(createUtf8PrefixTruncator(value, maxBytes)(maxBytes)).toBe(prefix);
      expect(truncateUtf8Suffix(value, maxBytes)).toBe(suffix);
    },
  );
});
