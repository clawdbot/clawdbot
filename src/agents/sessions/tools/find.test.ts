// find tool tests cover custom search operation wiring and result-limit
// normalization for session file discovery.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createFindToolDefinition, type FindOperations } from "./find.js";

function operations(results: string[]): FindOperations {
  return {
    exists: () => true,
    glob: (_pattern, _cwd, options) => results.slice(0, options.limit),
  };
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createFindToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function execute(tool: ReturnType<typeof createFindToolDefinition>, limit: number) {
  return tool.execute("call-1", { pattern: "*.ts", limit }, undefined, undefined, {} as never);
}

describe("find tool", () => {
  it("rejects fractional limits", async () => {
    const tool = createFindToolDefinition("/workspace", { operations: operations([]) });

    expect(Value.Check(tool.parameters, { pattern: "*.ts", limit: 1.5 })).toBe(false);
    await expect(execute(tool, 1.5)).rejects.toThrow("Limit must be an integer");
  });

  it("clamps non-positive limits before delegating to custom search operations", async () => {
    // Clamp before delegation so custom backends never receive a zero/negative
    // limit that could make real matches disappear.
    const tool = createFindToolDefinition("/workspace", {
      operations: operations(["/workspace/a.ts", "/workspace/b.ts"]),
    });

    const result = await execute(tool, -4);

    expect(textContent(result)).toBe("a.ts\n\n[1 results limit reached]");
    expect(result.details?.resultLimitReached).toBe(1);
  });

  it("uses the default limit for non-finite values", async () => {
    const tool = createFindToolDefinition("/workspace", {
      operations: operations(["/workspace/a.ts", "/workspace/b.ts"]),
    });

    const result = await execute(tool, Number.POSITIVE_INFINITY);

    expect(textContent(result)).toBe("a.ts\nb.ts");
    expect(result.details).toBeUndefined();
  });
});
