// find tool tests cover custom search operation wiring and result-limit
// normalization for session file discovery.
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
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

  it.each([
    {
      name: "keeps an exact-size result complete",
      results: ["/workspace/a.ts", "/workspace/b.ts"],
      expectedText: "a.ts\nb.ts",
      expectedLimitReached: undefined,
    },
    {
      name: "uses one extra result as the truncation sentinel",
      results: ["/workspace/a.ts", "/workspace/b.ts", "/workspace/c.ts"],
      expectedText: "a.ts\nb.ts\n\n[2 results limit reached]",
      expectedLimitReached: 2,
    },
  ])(
    "$name for custom glob operations",
    async ({ results, expectedText, expectedLimitReached }) => {
      const glob = vi.fn((_pattern: string, _cwd: string, options: { limit: number }) =>
        results.slice(0, options.limit),
      );
      const tool = createFindToolDefinition("/workspace", {
        operations: { exists: () => true, glob },
      });

      const result = await execute(tool, 2);

      expect(glob).toHaveBeenCalledWith("*.ts", "/workspace", {
        ignore: ["**/node_modules/**", "**/.git/**"],
        limit: 3,
      });
      expect(textContent(result)).toBe(expectedText);
      expect(result.details?.resultLimitReached).toBe(expectedLimitReached);
    },
  );
});
