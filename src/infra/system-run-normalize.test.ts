// Covers system-run metadata normalization helpers.
import { describe, expect, it } from "vitest";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

describe("system run normalization helpers", () => {
  it.each([
    { value: "  hello  ", expected: "hello" },
    { value: " \n\t ", expected: null },
    { value: 42, expected: null },
    { value: null, expected: null },
  ])("normalizes non-empty strings for %j", ({ value, expected }) => {
    expect(normalizeNonEmptyString(value)).toBe(expected);
  });

  it.each([
    { value: [" alpha ", 42, false], expected: [" alpha ", "42", "false"] },
    { value: undefined, expected: [] },
    { value: "alpha", expected: [] },
  ])("normalizes string arrays for %j", ({ value, expected }) => {
    expect(normalizeStringArray(value)).toEqual(expected);
  });
});
