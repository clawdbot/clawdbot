import { Value } from "typebox/value";
import { describe, it, expect } from "vitest";
import { createFindToolDefinition } from "./find.js";

const definition = createFindToolDefinition("/tmp/test-cwd");
const schema = definition.parameters;

describe("findSchema limit (production)", () => {
  it("accepts valid positive integer limit", () => {
    const result = Value.Check(schema, { pattern: "*.ts", limit: 10 });
    expect(result).toBe(true);
  });

  it("accepts limit=1", () => {
    const result = Value.Check(schema, { pattern: "*.ts", limit: 1 });
    expect(result).toBe(true);
  });

  it("accepts large integer limit", () => {
    const result = Value.Check(schema, { pattern: "*.ts", limit: 5000 });
    expect(result).toBe(true);
  });

  it("rejects float limit", () => {
    const result = Value.Check(schema, { pattern: "*.ts", limit: 5.5 });
    expect(result).toBe(false);
  });

  it("accepts zero limit (preserves runtime normalization)", () => {
    const result = Value.Check(schema, { pattern: "*.ts", limit: 0 });
    expect(result).toBe(true);
  });

  it("accepts negative limit (preserves runtime normalization)", () => {
    const result = Value.Check(schema, { pattern: "*.ts", limit: -1 });
    expect(result).toBe(true);
  });

  it("accepts omitted limit (optional)", () => {
    const result = Value.Check(schema, { pattern: "*.ts" });
    expect(result).toBe(true);
  });

  it("still validates required pattern", () => {
    const result = Value.Check(schema, { limit: 10 });
    expect(result).toBe(false);
  });

  it("execution boundary rejects float limit", async () => {
    await expect(
      definition.execute(
        "test-call",
        { pattern: "*.ts", limit: 5.5 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Limit must be an integer");
  });

  it("execution boundary does not reject valid integer limit", async () => {
    // Valid integer limit should NOT throw "Limit must be an integer".
    // It may throw other errors (e.g. fd not available), but those are unrelated.
    try {
      await definition.execute(
        "test-call",
        { pattern: "*.ts", limit: 10 },
        undefined,
        undefined,
        {} as never,
      );
    } catch (e) {
      expect(e instanceof Error ? e.message : String(e)).not.toContain("Limit must be an integer");
    }
  });

  it("execution boundary keeps default-limit fallback for non-finite values", async () => {
    // Number.POSITIVE_INFINITY bypasses JSON schema validation only via direct
    // execute calls; the established behavior falls back to the default limit
    // instead of rejecting (covered by find.test.ts on the delegation path).
    try {
      await definition.execute(
        "test-call",
        { pattern: "*.ts", limit: Number.POSITIVE_INFINITY },
        undefined,
        undefined,
        {} as never,
      );
    } catch (e) {
      expect(e instanceof Error ? e.message : String(e)).not.toContain("Limit must be an integer");
    }
  });
});
