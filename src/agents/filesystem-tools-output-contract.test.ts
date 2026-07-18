import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createEditTool, createReadTool } from "./sessions/index.js";
import { DEFAULT_MAX_BYTES } from "./sessions/tools/truncate.js";
import { compactToolOutputHint } from "./tool-schema-hints.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function expectContract(tool: AnyAgentTool, details: unknown): void {
  expect(tool.outputSchema).toBeDefined();
  expect(Value.Check(tool.outputSchema!, details)).toBe(true);
}

describe("filesystem tool output contracts", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-filesystem-contract-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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
    const notFound = await tool.execute("read-not-found", { path: "memory/2026-07-17.md" });

    for (const result of [text, image, truncated, notFound]) {
      expectContract(tool, result.details);
    }
    expect(text.details).toEqual({ kind: "text", content: "ordinary text\n" });
    expect(image.details).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(truncated.details).toMatchObject({ kind: "truncated" });
    expect(notFound.details).toEqual({
      kind: "not_found",
      status: "not_found",
      path: "memory/2026-07-17.md",
      optional: true,
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ content: string; kind: "text" } | { content: string; kind: "image"; mimeType: string } | { content: string; kind: "truncated"; truncation: { firstLineExceedsLimit: boolean; lastLinePartial: boolean; maxBytes: number; maxLines: number; outputBytes: number; outputLines: number; totalBytes: number; totalLines: number; truncated: true; truncatedBy: "lines" | "bytes" } } | { kind: "not_found"; optional: true; path: string; status: "not_found" }',
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
