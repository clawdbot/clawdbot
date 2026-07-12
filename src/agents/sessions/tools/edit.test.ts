// Edit tool tests cover exact-match diagnostics, post-write recovery, newline
// preservation, and preview rendering for custom operations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { applyPatch } from "diff";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import {
  createEditTool,
  createEditToolDefinition,
  type EditOperations,
  type EditToolDetails,
} from "./edit.js";

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
        {
          path: filePath,
          edits: [{ oldText: "missing", newText: "replacement" }],
        },
        undefined,
      ),
    ).rejects.toThrow(/Current file contents:\nactual current content/);
  });

  it("truncates exact-match mismatch hints without splitting UTF-16 surrogate pairs", async () => {
    const boundaryEmoji = "🙂";
    const filePath = await createTempFile(`${"a".repeat(799)}${boundaryEmoji}tail`);
    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [{ oldText: "missing", newText: "replacement" }],
        },
        undefined,
      ),
    ).rejects.toThrow(`${"a".repeat(799)}\n... (truncated)`);
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

  it("preserves untouched lines during fuzzy multi-edits", async () => {
    const original = [
      "keep before  ",
      "first target  ",
      "first after",
      "keep middle   ",
      "second target  ",
      "second after",
      "keep after  ",
      "",
    ].join("\n");
    const filePath = await createTempFile(original);
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-fuzzy",
      {
        path: filePath,
        edits: [
          { oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
          { oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
        ],
      },
      undefined,
    );

    const expected = [
      "keep before  ",
      "FIRST",
      "FIRST2",
      "keep middle   ",
      "SECOND",
      "SECOND2",
      "keep after  ",
      "",
    ].join("\n");
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(expected);
    const details = result.details as EditToolDetails;
    expect(applyPatch(original, details.patch)).toBe(expected);
  });

  it("preserves the correct duplicate line after a fuzzy replacement", async () => {
    const original = "replace me   \nafter   \n";
    const filePath = await createTempFile(original);
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-duplicate",
      {
        path: filePath,
        edits: [{ oldText: "replace me\n", newText: "after\n" }],
      },
      undefined,
    );

    const expected = "after\nafter   \n";
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(expected);
    const details = result.details as EditToolDetails;
    expect(applyPatch(original, details.patch)).toBe(expected);
  });

  it("strips model-added metadata while retaining the strict edit schema", async () => {
    const filePath = await createTempFile("before\n");
    const tool = createEditTool(tmpDir);
    const prepared = tool.prepareArguments?.({
      path: filePath,
      reason: "model explanation",
      edits: [{ oldText: "before", newText: "after", reason: "why" }],
    });

    expect(prepared).toEqual({
      path: filePath,
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    await tool.execute("call-metadata", prepared as never, undefined);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("after\n");
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

  it("filters fuzzy no-op edits from mixed previews", async () => {
    const readFile = vi.fn(async () => Buffer.from("foo\u00a0bar\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      writeFile: async () => {},
    };
    const tool = createEditToolDefinition("/workspace", { operations });
    const args = {
      path: "remote.txt",
      edits: [
        { oldText: "foo bar", newText: "foo bar" },
        { oldText: "foo\u00a0", newText: "baz" },
      ],
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
      toolCallId: "call-preview-mixed",
    };

    const component = tool.renderCall?.(args, testTheme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());

    expect(
      (component as { preview?: { error?: string; diff?: string } } | undefined)?.preview,
    ).toEqual(expect.objectContaining({ diff: expect.stringContaining("bazbar") }));
    expect(
      (component as { preview?: { error?: string } } | undefined)?.preview?.error,
    ).toBeUndefined();
  });

  it("validates no-op targets in mixed previews", async () => {
    const readFile = vi.fn(async () => Buffer.from("alpha beta\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      writeFile: async () => {},
    };
    const tool = createEditToolDefinition("/workspace", { operations });
    const args = {
      path: "remote.txt",
      edits: [
        { oldText: "missing", newText: "missing" },
        { oldText: "alpha", newText: "ALPHA" },
      ],
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
      toolCallId: "call-preview-invalid-no-op",
    };

    const component = tool.renderCall?.(args, testTheme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());

    expect((component as { preview?: { error?: string } } | undefined)?.preview?.error).toContain(
      "Could not find the exact text",
    );
  });

  it("returns terminal no-op when oldText equals newText", async () => {
    const filePath = await createTempFile("unchanged content\n");
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [{ oldText: "unchanged", newText: "unchanged" }],
      },
      undefined,
    );

    const tc0 = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tc0 ? tc0.text : "").toContain("No changes made");
    expect((result as any).terminate).toBe(true);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("unchanged content\n");
  });

  it("shows an empty preview for an all-no-op edit", async () => {
    const readFile = vi.fn(async () => Buffer.from("unchanged content\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      writeFile: async () => {},
    };
    const tool = createEditToolDefinition("/workspace", { operations });
    const args = {
      path: "remote.txt",
      edits: [{ oldText: "unchanged", newText: "unchanged" }],
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
      toolCallId: "call-preview-no-op",
    };

    const component = tool.renderCall?.(args, testTheme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());

    expect(
      (component as { preview?: { error?: string; diff?: string } } | undefined)?.preview,
    ).toEqual({ diff: "", firstChangedLine: undefined });
  });

  it("shows an empty preview for a fuzzy net no-op", async () => {
    const readFile = vi.fn(async () => Buffer.from("foo\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      writeFile: async () => {},
    };
    const tool = createEditToolDefinition("/workspace", { operations });
    const args = {
      path: "remote.txt",
      edits: [{ oldText: "foo ", newText: "foo" }],
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
      toolCallId: "call-preview-fuzzy-no-op",
    };

    const component = tool.renderCall?.(args, testTheme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());

    expect(
      (component as { preview?: { error?: string; diff?: string } } | undefined)?.preview,
    ).toEqual({ diff: "", firstChangedLine: undefined });
  });

  it("does not hide a mismatched no-op edit", async () => {
    const filePath = await createTempFile("actual content\n");
    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [{ oldText: "missing", newText: "missing" }],
        },
        undefined,
      ),
    ).rejects.toThrow(/Current file contents:\nactual content/);
  });

  it("does not hide unrelated errors that mention no changes", async () => {
    const filePath = await createTempFile("old content\n");
    const operations: EditOperations = {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      writeFile: async () => {
        throw new Error("No changes made to the disk because it is full");
      },
    };
    const tool = createEditTool(tmpDir, { operations });

    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [{ oldText: "old", newText: "new" }],
        },
        undefined,
      ),
    ).rejects.toThrow("No changes made to the disk because it is full");
  });

  it("does not rewrite fuzzy-matched no-op text", async () => {
    const filePath = await createTempFile("foo\n");
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [{ oldText: "foo ", newText: "foo " }],
      },
      undefined,
    );

    expect((result as any).terminate).toBe(true);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("foo\n");
  });

  it("preserves real sibling edits beside a fuzzy no-op", async () => {
    const filePath = await createTempFile("foo\u00a0bar\n");
    const tool = createEditTool(tmpDir);

    await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [
          { oldText: "foo bar", newText: "foo bar" },
          { oldText: "foo\u00a0", newText: "baz" },
        ],
      },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("bazbar\n");
  });

  it("preserves unrelated whitespace beside a fuzzy-equivalent no-op", async () => {
    const filePath = await createTempFile("foo  \nkeep  \n");
    const tool = createEditTool(tmpDir);

    await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [
          { oldText: "foo  ", newText: "foo" },
          { oldText: "keep", newText: "changed" },
        ],
      },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("foo  \nchanged  \n");
  });

  it("rejects duplicate no-op entries", async () => {
    const filePath = await createTempFile("foo\n");
    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [
            { oldText: "foo", newText: "foo" },
            { oldText: "foo", newText: "foo" },
          ],
        },
        undefined,
      ),
    ).rejects.toThrow(/overlap/);
  });

  it("rejects an exact no-op overlapping a real edit", async () => {
    const filePath = await createTempFile("foo\n");
    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [
            { oldText: "foo", newText: "foo" },
            { oldText: "foo", newText: "bar" },
          ],
        },
        undefined,
      ),
    ).rejects.toThrow(/overlap/);
  });

  it("preserves valid sibling edits when batch contains a no-op entry", async () => {
    const filePath = await createTempFile("alpha beta gamma\n");
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [
          { oldText: "alpha", newText: "alpha" }, // no-op
          { oldText: "gamma", newText: "GAMMA" }, // real change
        ],
      },
      undefined,
    );

    const tcText = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tcText ? tcText.text : "").toContain("Successfully replaced");
    expect((result as any).terminate).toBeFalsy();
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha beta GAMMA\n");
  });

  it("applies real changes normally (no false positive for no-op)", async () => {
    const filePath = await createTempFile("old content\n");
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        edits: [{ oldText: "old", newText: "new" }],
      },
      undefined,
    );

    const tc1 = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tc1 ? tc1.text : "").toContain("Successfully replaced");
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("new content\n");
  });
});
