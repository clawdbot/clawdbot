import { describe, it, expect } from "vitest";
import { grepSchema } from "./grep.js";

// Lightweight mock: validates integer schema properties reject non-integer values.
// Replaces the full typebox/value Check import to keep this scoped test lightweight.
function integerCheck(
  schema: { properties?: Record<string, { type?: string }> },
  value: Record<string, unknown>,
): boolean {
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.type === "integer") {
      const v = value[key];
      if (v !== undefined && !Number.isInteger(v)) return false;
    }
  }
  return true;
}

describe("grep tool context/limit schema", () => {
  it("rejects float context and limit — validates against production grepSchema", () => {
    expect(integerCheck(grepSchema, { pattern: "foo", context: 3, limit: 50 })).toBe(true);
    expect(integerCheck(grepSchema, { pattern: "foo", context: 1.5, limit: 50 })).toBe(false);
    expect(integerCheck(grepSchema, { pattern: "foo", context: 3, limit: 10.5 })).toBe(false);
    expect(integerCheck(grepSchema, { pattern: "foo" })).toBe(true);
  });
});
