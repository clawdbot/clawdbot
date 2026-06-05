// Edit tool tests cover exact-match diagnostics, post-write recovery, newline
// preservation, and preview rendering for custom operations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { createEditTool, createEditToolDefinition, type EditOperations } from "./edit.js";

const testTheme = {
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_name: string, text: string) => text,
} as Theme;

describe("edit tool", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function createTempFile(content: string) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-tool-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("adds current file contents to exact-match mismatch errors", async () => {
    const filePath = await createTempFile("actual current content");
    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        "call-1",
        { path: filePath, edits: [{ oldText: "missing", newText: "replacement" }] },
        undefined,
      ),
    ).rejects.toThrow(/Current file contents:\nactual current content/);
  });

  it("recovers success after a post-write throw when the edit already applied", async () => {
    // Some backends throw after flushing content; a readback match is the
    // contract that lets the tool report success without duplicating edits.
    const filePath = await createTempFile('const value = "foo";\r\n');
    const operations: EditOperations = {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      writeFile: async (absolutePath, content) => {
        await fs.writeFile(absolutePath, content, "utf-8");
        throw new Error("Simulated post-write failure");
      },
    };
    const tool = createEditTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [
          {
            oldText: 'const value = "foo";\n',
            newText: 'const value = "foobar";\n',
          },
        ],
      },
      undefined,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully replaced 1 block(s) in ${filePath}.`,
    });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe('const value = "foobar";\r\n');
  });

  it("does not recover false success when the file never changed", async () => {
    const filePath = await createTempFile("old replacement already present");
    const operations: EditOperations = {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      writeFile: async () => {
        throw new Error("Simulated write failure");
      },
    };
    const tool = createEditTool(tmpDir, { operations });

    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [{ oldText: "old", newText: "replacement already present" }],
        },
        undefined,
      ),
    ).rejects.toThrow("Simulated write failure");
  });

  it("recovers multi-edit post-write failures", async () => {
    const filePath = await createTempFile("alpha beta gamma delta\n");
    const operations: EditOperations = {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      writeFile: async (absolutePath, content) => {
        await fs.writeFile(absolutePath, content, "utf-8");
        throw new Error("Simulated post-write failure");
      },
    };
    const tool = createEditTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "delta", newText: "DELTA" },
        ],
      },
      undefined,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully replaced 2 block(s) in ${filePath}.`,
    });
  });

  it("renders previews through custom edit operations", async () => {
    // Preview rendering must use injected operations so remote/sandbox files are
    // shown without accidentally reading from the host filesystem.
    const readFile = vi.fn(async () => Buffer.from("remote original\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      writeFile: async () => {},
    };
    const tool = createEditToolDefinition("/workspace", { operations });
    const args = {
      path: "remote.txt",
      edits: [{ oldText: "remote original", newText: "remote changed" }],
    };
    const context = {
      args,
      argsComplete: true,
      cwd: "/workspace",
      executionStarted: false,
      expanded: false,
      invalidate: vi.fn(),
      isError: false,
      isPartial: false,
      lastComponent: undefined,
      showImages: false,
      state: {},
      toolCallId: "call-preview",
    };

    const component = tool.renderCall?.(args, testTheme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());

    expect(readFile).toHaveBeenCalledWith(path.join("/workspace", "remote.txt"));
    expect((component as { preview?: { diff?: string } } | undefined)?.preview?.diff).toContain(
      "remote changed",
    );
  });
});
