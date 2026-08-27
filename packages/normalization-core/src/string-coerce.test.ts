import {
  normalizeBoundedOptionalString,
  normalizeStringifiedEntries,
  readNonBlankString,
  readNonEmptyStringPreservingWhitespace,
} from "@openclaw/normalization-core/string-coerce";
// Normalization Core tests cover string coerce behavior.
import { describe, expect, it } from "vitest";

describe("normalization-core/string-coerce", () => {
  it("normalizes primitive stringified entries", () => {
    expect(normalizeStringifiedEntries([" a ", 42, true, 0n, "", "  ", null, {}])).toEqual([
      "a",
      "42",
      "true",
      "0",
    ]);
    expect(normalizeStringifiedEntries(undefined)).toEqual([]);
  });

  it.each([
    { value: " value ", maxLength: 5, expected: "value" },
    { value: " 😀 ", maxLength: 2, expected: "😀" },
    { value: "😀", maxLength: 1, expected: undefined },
    { value: " value ", maxLength: 4, expected: undefined },
    { value: "   ", maxLength: 3, expected: undefined },
    { value: 42, maxLength: 2, expected: undefined },
    { value: "value", maxLength: -1, expected: undefined },
    { value: "value", maxLength: 1.5, expected: undefined },
  ])("normalizes bounded optional strings", ({ value, maxLength, expected }) => {
    expect(normalizeBoundedOptionalString(value, maxLength)).toBe(expected);
  });

  it("distinguishes non-blank and non-empty whitespace-preserving reads", () => {
    expect(readNonBlankString(" value ")).toBe(" value ");
    expect(readNonBlankString("   ")).toBeUndefined();
    expect(readNonEmptyStringPreservingWhitespace("   ")).toBe("   ");
    expect(readNonEmptyStringPreservingWhitespace("")).toBeUndefined();
    expect(readNonEmptyStringPreservingWhitespace(null)).toBeUndefined();
  });
});
