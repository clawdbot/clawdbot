/**
 * Regression coverage for read tool `limit` schema tightening.
 *
 * Validates against the actual production `readSchema` from
 * `createReadToolDefinition`, not a standalone copy.
 *
 * Two validation layers:
 * 1. Schema layer: TypeBox Value.Check rejects float values
 * 2. Execution layer: tool.execute() rejects non-integer limit at runtime
 *
 * Covers: valid ints, float rejection, sibling offset, optional omission
 */
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createReadToolDefinition } from "./read.js";

describe("read tool limit schema (production)", () => {
  const toolDef = createReadToolDefinition("/tmp");
  const schema = toolDef.parameters;

  it("accepts valid integer limit", () => {
    expect(Value.Check(schema, { path: "/tmp/x", limit: 100 })).toBe(true);
  });

  it("rejects float limit at schema layer", () => {
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

describe("read tool limit execution boundary", () => {
  it("rejects float limit at execution boundary", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: vi.fn(async () => {}),
        detectImageMimeType: vi.fn(async () => null),
        readFile: vi.fn(async () => Buffer.from("test")),
      },
    });

    await expect(
      tool.execute("call-1", { path: "x.txt", limit: 3.14 }, undefined, undefined, {} as never),
    ).rejects.toThrow("Limit must be an integer");
  });

  it("accepts valid integer limit at execution boundary", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: vi.fn(async () => {}),
        detectImageMimeType: vi.fn(async () => null),
        readFile: vi.fn(async () => Buffer.from("line1\nline2\nline3")),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "x.txt", limit: 2 },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toBeDefined();
  });

  it("accepts non-positive integer limit (clamped at runtime)", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: vi.fn(async () => {}),
        detectImageMimeType: vi.fn(async () => null),
        readFile: vi.fn(async () => Buffer.from("alpha\nbeta\ngamma")),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "x.txt", limit: -1 },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toBeDefined();
  });
});
