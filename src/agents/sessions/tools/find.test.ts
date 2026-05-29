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

describe("find tool", () => {
  it("clamps non-positive limits before delegating to custom search operations", async () => {
    const tool = createFindToolDefinition("/workspace", {
      operations: operations(["/workspace/a.ts", "/workspace/b.ts"]),
    });

    const result = await tool.execute(
      "call-1",
      { pattern: "*.ts", limit: -4 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("a.ts\n\n[1 results limit reached]");
    expect(result.details?.resultLimitReached).toBe(1);
  });

  it("uses the default limit for non-finite values", async () => {
    const tool = createFindToolDefinition("/workspace", {
      operations: operations(["/workspace/a.ts", "/workspace/b.ts"]),
    });

    const result = await tool.execute(
      "call-1",
      { pattern: "*.ts", limit: Number.POSITIVE_INFINITY },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("a.ts\nb.ts");
    expect(result.details).toBeUndefined();
  });
});
