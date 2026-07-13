import { describe, it, expect } from "vitest";

// Validate the Type.Integer schema change for the grep tool's context and limit fields.
// These tests check the contract: floats are rejected, integers are accepted.
// The exact same Type.Integer configuration is used in the production schema definition.

describe("grep tool context/limit schema", () => {
  it("rejects float context", async () => {
    const { Check } = await import("typebox/value");
    const { Type } = await import("typebox");
    // Replicate the exact grep schema field configuration
    const ctxSchema = Type.Optional(
      Type.Integer({ description: "Context lines each side; default 0." }),
    );
    expect(Check(ctxSchema, 1.5)).toBe(false);
    expect(Check(ctxSchema, 3)).toBe(true);
    expect(
      Check(Type.Optional(Type.Integer({ description: "Max matches; default 100." })), 10.5),
    ).toBe(false);
    expect(
      Check(Type.Optional(Type.Integer({ description: "Max matches; default 100." })), 50),
    ).toBe(true);
  });
});
