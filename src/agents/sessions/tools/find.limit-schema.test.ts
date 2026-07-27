import { Value } from "typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "./find.js";

let receivedLimit: number | undefined;
const definition = createFindToolDefinition("/tmp/test-cwd", {
  operations: {
    exists: () => true,
    glob: (_pattern, _cwd, options) => {
      receivedLimit = options.limit;
      return ["/tmp/test-cwd/result.ts"];
    },
  },
});
const schema = definition.parameters;

describe("findSchema limit (production)", () => {
  beforeEach(() => {
    receivedLimit = undefined;
  });

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

    expect(receivedLimit).toBeUndefined();
  });

  it("execution boundary does not reject valid integer limit", async () => {
    const result = await definition.execute(
      "test-call",
      { pattern: "*.ts", limit: 10 },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "result.ts" }]);
    expect(receivedLimit).toBe(10);
  });
});
