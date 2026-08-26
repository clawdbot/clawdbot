import { describe, expect, it } from "vitest";
import {
  MAX_VALIDATION_NESTING_DEPTH,
  measureConfigNestingDepth,
  checkConfigNestingDepth,
} from "./validation-nesting-guard.js";
import { validateConfigObjectRaw } from "./validation.js";

describe("measureConfigNestingDepth", () => {
  it("returns 0 for primitives", () => {
    expect(measureConfigNestingDepth(null)).toBe(0);
    expect(measureConfigNestingDepth(undefined)).toBe(0);
    expect(measureConfigNestingDepth("string")).toBe(0);
    expect(measureConfigNestingDepth(42)).toBe(0);
  });

  it("returns 1 for a shallow object", () => {
    expect(measureConfigNestingDepth({})).toBe(1);
    expect(measureConfigNestingDepth({ a: 1 })).toBe(1);
  });

  it("returns 1 for a shallow array", () => {
    expect(measureConfigNestingDepth([])).toBe(1);
    expect(measureConfigNestingDepth([1, 2, 3])).toBe(1);
  });

  it("measures nested object depth", () => {
    expect(measureConfigNestingDepth({ a: { b: { c: 1 } } })).toBe(3);
  });

  it("measures nested array depth", () => {
    expect(measureConfigNestingDepth([[[1]]])).toBe(3);
  });

  it("measures the deepest branch", () => {
    const value = { shallow: 1, deep: { a: { b: { c: 1 } } } };
    expect(measureConfigNestingDepth(value)).toBe(4);
  });

  it("handles deeply-nested input without stack overflow", () => {
    // 10 000 levels — must not throw RangeError (iterative, not recursive).
    let value: unknown = 1;
    for (let i = 0; i < 10_000; i += 1) {
      value = { a: value };
    }
    expect(() => measureConfigNestingDepth(value)).not.toThrow();
    expect(measureConfigNestingDepth(value)).toBe(10_000);
  });
});

describe("checkConfigNestingDepth", () => {
  it("passes shallow config values", () => {
    expect(checkConfigNestingDepth({ agents: { entries: {} } }, "Config")).toEqual({ ok: true });
  });

  it("passes values at the maximum supported depth", () => {
    let value: unknown = 1;
    for (let i = 0; i < MAX_VALIDATION_NESTING_DEPTH - 1; i += 1) {
      value = { a: value };
    }
    expect(checkConfigNestingDepth(value, "Config")).toEqual({ ok: true });
  });

  it("rejects values exceeding the maximum depth", () => {
    let value: unknown = 1;
    for (let i = 0; i < MAX_VALIDATION_NESTING_DEPTH + 1; i += 1) {
      value = { a: value };
    }
    const result = checkConfigNestingDepth(value, "Config");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toContain("maximum supported nesting depth");
      expect(result.issues[0].message).toContain(String(MAX_VALIDATION_NESTING_DEPTH));
    }
  });
});

describe("validateConfigObjectRaw nesting guard", () => {
  it("returns a clean validation error for deeply-nested input instead of crashing", () => {
    // Mirrors the issue #129734 reproduction: a 20 000-level nested object.
    // Without the guard, Zod strictObject allocates O(n²) issue paths and
    // exhausts the V8 heap before the error wrapper can run.
    let value: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) {
      value = { a: value };
    }
    const result = validateConfigObjectRaw(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      expect(result.issues[0].message).toContain("maximum supported nesting depth");
    }
  });

  it("does not affect normal shallow config validation", () => {
    const result = validateConfigObjectRaw({ agents: { entries: { main: {} } } });
    // Shallow configs pass the nesting guard and proceed to normal schema validation.
    expect(result.ok).toBe(true);
  });
});
