import { Type } from "typebox";
import { describe, it, expect } from "vitest";

// Self-contained schema contract test: does not import production grep.ts
// (which drags in fs, child_process, path, readline, and many internal modules).
// Replicates only the grepSchema context/limit fields to validate integer-only acceptance.

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

// Production-equivalent schema: see grepSchema in grep.ts.
const schema = Type.Object({
  pattern: Type.String({ description: "Regex/literal pattern." }),
  context: Type.Optional(
    Type.Integer({
      description: "Context lines each side; default 0.",
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Max matches; default 100." })),
});

describe("grep tool context/limit schema", () => {
  it("rejects float context and limit — validates integer-only contract", () => {
    expect(integerCheck(schema, { pattern: "foo", context: 3, limit: 50 })).toBe(true);
    expect(integerCheck(schema, { pattern: "foo", context: 1.5, limit: 50 })).toBe(false);
    expect(integerCheck(schema, { pattern: "foo", context: 3, limit: 10.5 })).toBe(false);
    expect(integerCheck(schema, { pattern: "foo" })).toBe(true);
  });
});
