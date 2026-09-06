import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createEditTool, createReadTool, createWriteTool } from "./sessions/index.js";
import { createFindTool } from "./sessions/tools/find.js";
import { createGrepTool } from "./sessions/tools/grep.js";
import { createLsTool } from "./sessions/tools/ls.js";
import { DEFAULT_MAX_BYTES } from "./sessions/tools/truncate.js";
import { compactToolOutputHint } from "./tool-schema-hints.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function expectContract(tool: AnyAgentTool, details: unknown): void {
  expect(tool.outputSchema).toBeDefined();
  expect(Value.Check(tool.outputSchema!, details)).toBe(true);
}

async function callThroughCodeMode(tool: AnyAgentTool, args: Record<string, unknown>) {
  const harness = createCodeModeHarness();
  applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, tool] });
  return await runUntilCompleted({
    execTool: harness.tools[0]!,
    waitTool: harness.tools[1]!,
    code: `return await ${tool.name}(${JSON.stringify(args)});`,
  });
}

describe("filesystem tool output contracts", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-filesystem-contract-"));
  });

  afterEach(async () => {
    resetCodeModeTestState();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    { mode: "empty", files: [], args: {}, output: "(empty directory)" },
    {
      mode: "complete",
      files: ["alpha.txt", "beta.txt"],
      args: {},
      output: '"alpha.txt"\n"beta.txt"',
    },
    {
      mode: "paged",
      files: ["alpha.txt", "beta.txt"],
      args: { limit: 1 },
      output: '"alpha.txt"\n\n[More entries. Continue with the same path and after="alpha.txt".]',
      nextAfter: "alpha.txt",
    },
  ])(
    "preserves $mode directory output through Code Mode",
    async ({ files, args, output, nextAfter }) => {
      await Promise.all(files.map((file) => fs.writeFile(path.join(tmpDir, file), "fixture\n")));
      const tool = createLsTool(tmpDir) as unknown as AnyAgentTool;
      const direct = await tool.execute("direct-ls", args);
      const result = await callThroughCodeMode(tool, args);

      expect(direct.content).toEqual([{ type: "text", text: output }]);
      expect(result).toMatchObject({
        status: "completed",
        value: { content: output, ...(nextAfter === undefined ? {} : { nextAfter }) },
      });
    },
  );

  it.each([
    { mode: "matching", files: ["alpha.txt"], limit: 10, content: "alpha.txt" },
    { mode: "empty", files: [], limit: 10, content: "No files found matching pattern" },
    {
      mode: "limited",
      files: ["alpha.txt", "beta.txt"],
      limit: 1,
      content: "alpha.txt\n\n[1 results limit reached]",
      resultLimitReached: 1,
    },
  ])(
    "preserves $mode file search output through Code Mode",
    async ({ files, limit, content, resultLimitReached }) => {
      await Promise.all(files.map((file) => fs.writeFile(path.join(tmpDir, file), "fixture\n")));
      const tool = createFindTool(tmpDir, {
        operations: {
          exists: (absolutePath) =>
            fs.access(absolutePath).then(
              () => true,
              () => false,
            ),
          glob: async (pattern, cwd, options) => {
            const matches: string[] = [];
            for await (const match of fs.glob(pattern, { cwd })) {
              matches.push(match);
            }
            return matches.toSorted().slice(0, options.limit);
          },
        },
      }) as unknown as AnyAgentTool;
      const args = { pattern: "*.txt", limit };
      const direct = await tool.execute("direct-find", args);
      const result = await callThroughCodeMode(tool, args);

      expect(direct.content).toEqual([{ type: "text", text: content }]);
      expect(result).toMatchObject({
        status: "completed",
        value: { content, ...(resultLimitReached === undefined ? {} : { resultLimitReached }) },
      });
    },
  );

  it.each([
    {
      mode: "matching",
      pattern: "needle",
      limit: 10,
      content: "sample.txt:1: needle alpha\nsample.txt:2: needle beta",
    },
    { mode: "empty", pattern: "absent", limit: 10, content: "No matches found" },
    {
      mode: "limited",
      pattern: "needle",
      limit: 1,
      content:
        "sample.txt:1: needle alpha\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]",
      matchLimitReached: 1,
    },
  ])(
    "preserves $mode text search output through Code Mode",
    async ({ pattern, limit, content, matchLimitReached }) => {
      await fs.writeFile(path.join(tmpDir, "sample.txt"), "needle alpha\nneedle beta\n");
      const tool = createGrepTool(tmpDir) as unknown as AnyAgentTool;
      const args = { pattern, limit };
      const direct = await tool.execute("direct-grep", args);
      const result = await callThroughCodeMode(tool, args);

      expect(direct.content).toEqual([{ type: "text", text: content }]);
      expect(result).toMatchObject({
        status: "completed",
        value: { content, ...(matchLimitReached === undefined ? {} : { matchLimitReached }) },
      });
    },
  );

  it("keeps oversized find output inside the Code Mode value budget", async () => {
    // ASCII output fits once, but its duplicate crosses the Code Mode value budget.
    const longName = "f".repeat(240);
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        fs.writeFile(path.join(tmpDir, `${longName}-${index}.txt`), "fixture\n"),
      ),
    );
    const tool = createFindTool(tmpDir, {
      operations: {
        exists: (absolutePath) =>
          fs.access(absolutePath).then(
            () => true,
            () => false,
          ),
        glob: async (pattern, cwd, options) => {
          const matches: string[] = [];
          for await (const match of fs.glob(pattern, { cwd })) {
            matches.push(match);
          }
          return matches.toSorted().slice(0, options.limit);
        },
      },
    });
    const args = { pattern: "*.txt" };

    const direct = await tool.execute("direct-find", args);
    expect(direct.details.truncation?.truncated).toBe(true);
    expect(direct.details.content).toContain(longName);

    const result = await callThroughCodeMode(tool, args);
    expect(result).toMatchObject({ status: "completed", value: direct.details });
    expect(direct.details.truncation).not.toHaveProperty("content");
  });

  it("keeps oversized grep output inside the Code Mode value budget", async () => {
    // The path prefix makes 100 capped match rows exceed the tool's byte limit.
    const longDir = path.join(tmpDir, "d".repeat(60));
    await fs.mkdir(longDir, { recursive: true });
    const matchLine = `${"m".repeat(500)}\n`;
    await fs.writeFile(path.join(longDir, "sample.txt"), matchLine.repeat(120), "utf8");
    const tool = createGrepTool(tmpDir);
    const args = { pattern: "m+" };

    const direct = await tool.execute("direct-grep", args);
    expect(direct.details.truncation?.truncated).toBe(true);
    expect(direct.details.content).toContain("sample.txt:");

    const result = await callThroughCodeMode(tool, args);
    expect(result).toMatchObject({ status: "completed", value: direct.details });
    expect(direct.details.truncation).not.toHaveProperty("content");
  });

  it("validates read text, image, truncation, and optional-not-found results", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "ordinary text\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "pixel.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
    await fs.writeFile(path.join(tmpDir, "long.txt"), "x".repeat(DEFAULT_MAX_BYTES + 1), "utf8");

    const tool = createOpenClawReadTool(
      createReadTool(tmpDir, { autoResizeImages: false }) as unknown as AnyAgentTool,
    );
    const text = await tool.execute("read-text", { path: "notes.txt", limit: 10 });
    const image = await tool.execute("read-image", { path: "pixel.png", limit: 10 });
    const truncated = await tool.execute("read-truncated", { path: "long.txt", limit: 10 });
    const notFound = await tool.execute("read-not-found", {
      path: "memory/2026-07-17.md",
      optional: true,
    });

    for (const result of [text, image, truncated, notFound]) {
      expectContract(tool, result.details);
    }
    expect(text.details).toEqual({ kind: "text", content: "ordinary text\n" });
    expect(image.details).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(truncated.details).toMatchObject({
      kind: "truncated",
      truncation: { totalBytes: DEFAULT_MAX_BYTES + 1 },
    });
    expect(notFound.details).toEqual({
      kind: "not_found",
      status: "not_found",
      path: "memory/2026-07-17.md",
      optional: true,
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ content: string; kind: "text" } | { content: string; kind: "image"; mimeType: string } | { content: string; continuation: { kind: "line"; offset: number; limit?: number } | { cursor: number; kind: "cursor"; offset: number; limit?: number }; kind: "truncated"; truncation: { firstLineExceedsLimit: boolean; lastLinePartial: boolean; maxBytes: number; maxLines: number; outputBytes: number; outputLines: number; totalBytes: number; totalLines: number; truncated: true; truncatedBy: "lines" | "bytes" } } | { kind: "not_found"; optional: true; path: string; status: "not_found" }',
    );
  });

  it("validates edit changed and no-op results", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "before\n", "utf8");
    const tool = createEditTool(tmpDir) as unknown as AnyAgentTool;
    const changed = await tool.execute("edit-changed", {
      path: filePath,
      edits: [{ oldText: "before", newText: "after" }],
    });
    const noOp = await tool.execute("edit-no-op", {
      path: filePath,
      edits: [{ oldText: "after", newText: "after" }],
    });

    expectContract(tool, changed.details);
    expectContract(tool, noOp.details);
    expect(changed.details).toMatchObject({ changed: true });
    expect(noOp.details).toEqual({ changed: false });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ changed: false } | { changed: true; diff: string; patch: string; firstChangedLine?: number }",
    );
  });

  it("validates write created, overwrite, unknown-state, and no-op results", async () => {
    const tool = createWriteTool(tmpDir) as unknown as AnyAgentTool;
    const created = await tool.execute("write-created", { path: "write.txt", content: "one\n" });
    const overwritten = await tool.execute("write-overwrite", {
      path: "write.txt",
      content: "two\n",
    });
    const noOp = await tool.execute("write-no-op", { path: "write.txt", content: "two\n" });
    await fs.writeFile(path.join(tmpDir, "large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
    const unknownOverwrite = await tool.execute("write-unknown-overwrite", {
      path: "large.txt",
      content: "replacement\n",
    });
    const boundedCreate = await tool.execute("write-bounded-create", {
      path: "large-created.txt",
      content: "x".repeat(1024 * 1024 + 1),
    });

    for (const result of [created, overwritten, unknownOverwrite, boundedCreate, noOp]) {
      expectContract(tool, result.details);
    }
    expectContract(tool, { changed: true });
    expect(created.details).toMatchObject({ changed: true, created: true });
    expect(overwritten.details).toMatchObject({ changed: true, created: false });
    expect(unknownOverwrite.details).toEqual({ changed: true, created: false });
    expect(boundedCreate.details).toEqual({ changed: true, created: true });
    expect(noOp.details).toEqual({ changed: false });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ changed: false } | { changed: true; created: true; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created: false; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created?: boolean }",
    );
  });

  it("validates apply_patch path summaries", async () => {
    const tool = createApplyPatchTool({ cwd: tmpDir }) as unknown as AnyAgentTool;
    const result = await tool.execute("patch-add", {
      input: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch",
    });

    expectContract(tool, result.details);
    expect(result.details).toEqual({
      summary: { added: ["added.txt"], modified: [], deleted: [] },
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ summary: { added: Array<string>; deleted: Array<string>; modified: Array<string> } }",
    );
  });
});
