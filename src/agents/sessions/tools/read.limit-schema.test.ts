/**
 * Regression coverage for read tool `limit` schema tightening.
 *
 * Validates against the actual production `readSchema` from
 * `createReadToolDefinition`, not a standalone copy.
 *
 * Covers Type.Number → Type.Integer conversion:
 * - valid integers accepted
 * - floats rejected at schema layer
 * - omitted limit accepted (optional)
 * - sibling `offset` with Type.Integer({ minimum: 1 }) unaffected
 */
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createReadToolDefinition } from "./read.js";

const toolDef = createReadToolDefinition("/tmp");
const schema = toolDef.parameters;

describe("read tool limit schema (production)", () => {
  it("accepts valid integer limit", () => {
    expect(Value.Check(schema, { path: "/tmp/x", limit: 100 })).toBe(true);
  });

  it("rejects float limit", () => {
    expect(Value.Check(schema, { path: "/tmp/x", limit: 3.14 })).toBe(false);
  });

  it("accepts omitted limit (optional)", () => {
    expect(Value.Check(schema, { path: "/tmp/x" })).toBe(true);
  });

  it("accepts valid integer offset (sibling field)", () => {
    expect(Value.Check(schema, { path: "/tmp/x", offset: 1 })).toBe(true);
  });

  it("still validates required path", () => {
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { limit: 10 })).toBe(false);
  });
});
