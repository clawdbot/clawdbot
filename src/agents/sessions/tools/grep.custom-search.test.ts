import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnCommand } from "../../../process/exec.js";
import { createGrepToolDefinition } from "./grep.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

vi.mock("../../../process/exec.js", () => ({ spawnCommand: vi.fn() }));
vi.mock("../../utils/tools-manager.js", () => ({ ensureTool: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("grep custom-search output", () => {
  it("merges overlapping custom-search context and separates disjoint blocks", async () => {
    const filePath = "/workspace/match.txt";
    const tool = createGrepToolDefinition("/workspace", {
      operations: {
        isDirectory: () => true,
        readFile: () =>
          "first\nneedle two\nneedle three\nfourth\nfifth\nsixth\nseventh\nneedle eight\n",
        search: async () => [
          { filePath, lineNumber: 2 },
          { filePath, lineNumber: 3 },
          { filePath, lineNumber: 8 },
        ],
      },
    });

    const result = await tool.execute(
      "custom-context",
      { pattern: "needle", context: 1 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe(
      [
        "match.txt-1- first",
        "match.txt:2: needle two",
        "match.txt:3: needle three",
        "match.txt-4- fourth",
        "--",
        "match.txt-7- seventh",
        "match.txt:8: needle eight",
      ].join("\n"),
    );
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("stops reading custom-search context when the output byte budget is exhausted", async () => {
    const firstPath = "/workspace/first.txt";
    const secondPath = "/workspace/second.txt";
    const readFile = vi.fn(async () =>
      Array.from({ length: 120 }, (_, index) => `${index}-${"x".repeat(600)}`).join("\n"),
    );
    const tool = createGrepToolDefinition("/workspace", {
      operations: {
        isDirectory: () => true,
        readFile,
        search: async () => [
          { filePath: firstPath, lineNumber: 60 },
          { filePath: secondPath, lineNumber: 1 },
        ],
      },
    });

    const result = await tool.execute(
      "bounded-custom-context",
      { pattern: "needle", context: 1_000 },
      undefined,
      undefined,
      {} as never,
    );

    expect(readFile).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith(firstPath, { signal: expect.any(AbortSignal) });
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "bytes",
      maxBytes: DEFAULT_MAX_BYTES,
    });
    const rendered = textContent(result).split("\n\n[")[0] ?? "";
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(rendered).not.toContain("second.txt");
  });
});
