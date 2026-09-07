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
import { createEditTool, createEditToolDefinition, type EditOperations } from "./edit.js";
import type { EditToolDetails } from "./tool-contracts.js";

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

  async function createTempFile(content: string | Buffer) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-tool-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async function statEditFile(absolutePath: string) {
    try {
      const stat = await fs.stat(absolutePath);
      return {
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  it("preserves a valid UTF-8 BOM when editing a real file", async () => {
    const filePath = await createTempFile(Buffer.from("\uFEFFheading\nprice: 5\n", "utf-8"));
    const tool = createEditTool(tmpDir);

    await tool.execute(
      "call-bom",
      {
        path: filePath,
        edits: [{ oldText: "price: 5", newText: "price: 7" }],
      },
      undefined,
    );

    await expect(fs.readFile(filePath)).resolves.toEqual(
      Buffer.from("\uFEFFheading\nprice: 7\n", "utf-8"),
    );
  });

  it("writes and reports only the requested fuzzy Unicode replacement", async () => {
    const original =
      "export const RETRY\u00A0MAX = 3; // \u518D\u8A66\u884C\uFF08\u6700\u5927\uFF13\u56DE\uFF09\uFF71\uFF72\uFF73 \u2014 \u8A2D\u5B9A\n";
    const expected =
      "export const RETRY_MAX = 5; // \u518D\u8A66\u884C\uFF08\u6700\u5927\uFF13\u56DE\uFF09\uFF71\uFF72\uFF73 \u2014 \u8A2D\u5B9A\n";
    const filePath = await createTempFile(original);
    const tool = createEditTool(tmpDir);

    const result = await tool.execute(
      "call-fuzzy-unicode",
      {
        path: filePath,
        edits: [{ oldText: "export const RETRY MAX = 3;", newText: "export const RETRY_MAX = 5;" }],
      },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(expected);
    const details = result.details as EditToolDetails;
    expect(details.changed).toBe(true);
    if (!details.changed) {
      throw new Error("Expected the edit to change the file.");
    }
    expect(details.diff).toContain(
      "+1 export const RETRY_MAX = 5; // \u518D\u8A66\u884C\uFF08\u6700\u5927\uFF13\u56DE\uFF09\uFF71\uFF72\uFF73 \u2014 \u8A2D\u5B9A",
    );
    expect(details.diff).not.toContain("// \u518D\u8A66\u884C(\u6700\u59273\u56DE)");
    expect(applyPatch(original, details.patch)).toBe(expected);
  });

  it("rejects invalid UTF-8 without changing a real file", async () => {
    const original = Buffer.concat([Buffer.from("heading\nprice: 5\n"), Buffer.from([0xff, 0xfe])]);
    const filePath = await createTempFile(original);
    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        "call-invalid-utf8",
        {
          path: filePath,
          edits: [{ oldText: "price: 5", newText: "price: 7" }],
        },
        undefined,
      ),
    ).rejects.toThrow(/not valid UTF-8/);

    await expect(fs.readFile(filePath)).resolves.toEqual(original);
  });

  it("rejects invalid remote-operation UTF-8 before any write", async () => {
    const original = Buffer.concat([Buffer.from("heading\nprice: 5\n"), Buffer.from([0xff, 0xfe])]);
    const writeFile = vi.fn<EditOperations["writeFile"]>();
    const operations: EditOperations = {
      access: async () => {},
      readFile: async () => Buffer.from(original),
      statFile: async () => null,
      writeFile,
    };
    const tool = createEditTool("/remote/workspace", { operations });

    await expect(
      tool.execute(
        "call-remote-invalid-utf8",
        {
          path: "/remote/workspace/source.txt",
          edits: [{ oldText: "price: 5", newText: "price: 7" }],
        },
        undefined,
      ),
    ).rejects.toThrow(/not valid UTF-8/);

    expect(writeFile).not.toHaveBeenCalled();
  });

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
      statFile: statEditFile,
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
      statFile: statEditFile,
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

  it("rejects false success when a delegated write resolves without persisting", async () => {
    const filePath = await createTempFile("old\n");
    const operations: EditOperations = {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: statEditFile,
      writeFile: async () => {},
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
    ).rejects.toThrow("Edit verification failed");
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("old\n");
  });

  it("recovers multi-edit post-write failures", async () => {
    const filePath = await createTempFile("alpha beta gamma delta\n");
    const operations: EditOperations = {
      access: async (absolutePath) => {
        await fs.access(absolutePath);
      },
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: statEditFile,
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
    expect(details.changed).toBe(true);
    if (!details.changed) {
      throw new Error("expected changed edit details");
    }
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
    expect(details.changed).toBe(true);
    if (!details.changed) {
      throw new Error("expected changed edit details");
    }
    expect(applyPatch(original, details.patch)).toBe(expected);
  });

  it("accepts and strips model-added metadata while keeping required fields strict", async () => {
    const filePath = await createTempFile("before\n");
    const tool = createEditTool(tmpDir);
    const raw = {
      path: filePath,
      reason: "model explanation",
      edits: [{ oldText: "before", newText: "after", reason: "why" }],
    };
    const prepared = tool.prepareArguments?.(raw);

    expect(Value.Check(tool.parameters, raw)).toBe(true);
    expect(Value.Check(tool.parameters, { edits: raw.edits })).toBe(false);
    expect(Value.Check(tool.parameters, { path: filePath, edits: [{ oldText: "before" }] })).toBe(
      false,
    );
    expect(prepared).toEqual({
      path: filePath,
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    await tool.execute("call-metadata", prepared as never, undefined);
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("after\n");
  });

  it.each(["local", "injected"] as const)(
    "renders @ previews through %s operations",
    async (backend) => {
      await createTempFile("plain sibling\n");
      await fs.writeFile(path.join(tmpDir, "@demo.txt"), "local original\n");
      const readFile = vi.fn(async () => Buffer.from("remote original\n"));
      const operations: EditOperations = {
        access: async () => {},
        readFile,
        statFile: async () => null,
        writeFile: async () => {},
      };
      const tool = createEditToolDefinition(
        tmpDir,
        backend === "injected" ? { operations } : undefined,
      );
      const owner = backend === "injected" ? "remote" : "local";
      const args = {
        path: "@demo.txt",
        edits: [{ oldText: `${owner} original`, newText: `${owner} changed` }],
      };
      const context = {
        args,
        argsComplete: true,
        cwd: tmpDir,
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

      if (backend === "injected") {
        expect(readFile).toHaveBeenCalledWith(path.join(tmpDir, "demo.txt"));
      } else {
        expect(readFile).not.toHaveBeenCalled();
      }
      const preview = (component as { preview?: { error?: string; diff?: string } } | undefined)
        ?.preview;
      expect(preview?.error).toBeUndefined();
      expect(preview?.diff).toContain(`${owner} changed`);
      await expect(fs.readFile(path.join(tmpDir, "@demo.txt"), "utf8")).resolves.toBe(
        "local original\n",
      );
      await expect(fs.readFile(path.join(tmpDir, "demo.txt"), "utf8")).resolves.toBe(
        "plain sibling\n",
      );
    },
  );

  it("renders fuzzy Unicode previews from the original source bytes", async () => {
    const readFile = vi.fn(async () =>
      Buffer.from(
        "const label\u00A0= \u201Chello\u201D; // keep \uFF08\uFF13\uFF09 \u2014 unchanged\n",
      ),
    );
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      statFile: async () => null,
      writeFile: async () => {},
    };
    const tool = createEditToolDefinition("/workspace", { operations });
    const args = {
      path: "remote.txt",
      edits: [{ oldText: 'const label = "hello";', newText: "const label = 'hi';" }],
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
      toolCallId: "call-preview-fuzzy-unicode",
    };

    const component = tool.renderCall?.(args, testTheme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalled());

    const preview = (component as { preview?: { error?: string; diff?: string } } | undefined)
      ?.preview;
    expect(preview?.error).toBeUndefined();
    expect(preview?.diff).toContain(
      "+1 const label = 'hi'; // keep \uFF08\uFF13\uFF09 \u2014 unchanged",
    );
    expect(preview?.diff).not.toContain("// keep (3) - unchanged");
  });

  it("filters fuzzy no-op edits from mixed previews", async () => {
    const readFile = vi.fn(async () => Buffer.from("foo\u00a0bar\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      statFile: async () => null,
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
      statFile: async () => null,
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

  it("returns a non-terminal no-op when oldText equals newText", async () => {
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
    expect((result as { terminate?: boolean }).terminate).toBeUndefined();
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("unchanged content\n");
  });

  it("shows an empty preview for an all-no-op edit", async () => {
    const readFile = vi.fn(async () => Buffer.from("unchanged content\n"));
    const operations: EditOperations = {
      access: async () => {},
      readFile,
      statFile: async () => null,
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
      statFile: async () => null,
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
      statFile: statEditFile,
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

    expect((result as { terminate?: boolean }).terminate).toBeUndefined();
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

  it("applies exact formatting beside a disjoint content replacement", async () => {
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

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("foo\nchanged  \n");
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
    expect((result as { terminate?: boolean }).terminate).toBeFalsy();
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

  const lineEndingCases = [
    {
      name: "keeps a lone carriage return that carries data",
      original: "start\n10%\r50%\r100%\ndone\n",
      edits: [{ oldText: "done", newText: "finished" }],
      expected: "start\n10%\r50%\r100%\nfinished\n",
    },
    {
      name: "keeps a lone carriage return that terminates the edited line",
      original: "prefix\rprogress\n",
      edits: [{ oldText: "prefix", newText: "PREFIX" }],
      expected: "PREFIX\rprogress\n",
    },
    {
      name: "keeps carriage return separators when a middle record is rewritten",
      original: "id=1\rid=2\rid=3\nfooter\n",
      edits: [{ oldText: "id=2", newText: "id=two" }],
      expected: "id=1\rid=two\rid=3\nfooter\n",
    },
    {
      name: "expands a carriage return terminated line into carriage return terminated lines",
      original: "id=1\rid=2\nfooter\n",
      edits: [{ oldText: "id=1", newText: "id=1a\nid=1b" }],
      expected: "id=1a\rid=1b\rid=2\nfooter\n",
    },
    {
      name: "keeps a lone carriage return at end of file on the edited line",
      original: "only\r",
      edits: [{ oldText: "only", newText: "ONLY" }],
      expected: "ONLY\r",
    },
    {
      name: "uses the first carriage return for a leading inserted line",
      original: "alpha\rbeta\r",
      edits: [{ oldText: "alpha", newText: "prefix\nalpha" }],
      expected: "prefix\ralpha\rbeta\r",
    },
    {
      name: "uses the retained target terminator for a prefixed line",
      original: "alpha\r\nbeta\ngamma\n",
      edits: [{ oldText: "beta", newText: "prefix\nbeta" }],
      expected: "alpha\r\nprefix\nbeta\ngamma\n",
    },
    {
      name: "uses the edited target terminator for an appended line",
      original: "alpha\r\nbeta\n",
      edits: [{ oldText: "alpha", newText: "alpha\nsuffix" }],
      expected: "alpha\r\nsuffix\r\nbeta\n",
    },
    {
      name: "keeps neighboring duplicate line terminators unchanged",
      original: "A\r\nB\nC\r",
      edits: [{ oldText: "A", newText: "B" }],
      expected: "B\r\nB\nC\r",
    },
    {
      name: "preserves mixed terminators during a fuzzy multi-line edit",
      original: "keep\r\ntarget   \nafter\r\n",
      edits: [{ oldText: "target\nafter", newText: "TARGET\nAFTER" }],
      expected: "keep\r\nTARGET\nAFTER\r\n",
    },
    {
      name: "keeps the trailing boundary when replacement collapses mixed lines",
      original: "alpha\r\nbeta\ngamma\n",
      edits: [{ oldText: "alpha\nbeta", newText: "merged" }],
      expected: "merged\ngamma\n",
    },
    {
      name: "uses the last consumed terminator when collapsing complete lines",
      original: "alpha\r\nbeta\ngamma\n",
      edits: [{ oldText: "alpha\nbeta\n", newText: "combined\n" }],
      expected: "combined\ngamma\n",
    },
    {
      name: "aligns an unterminated replacement at end of file",
      original: "h1\r\nh2\r\none\ntwo",
      edits: [{ oldText: "one\ntwo", newText: "x\ny" }],
      expected: "h1\r\nh2\r\nx\ny",
    },
    {
      name: "keeps trailing CRLF lines when the first line ends with LF",
      original: "alpha\nbeta\r\ngamma\r\n",
      edits: [{ oldText: "alpha", newText: "ALPHA" }],
      expected: "ALPHA\nbeta\r\ngamma\r\n",
    },
    {
      name: "keeps trailing LF lines when the first line ends with CRLF",
      original: "alpha\r\nbeta\ngamma\n",
      edits: [{ oldText: "gamma", newText: "GAMMA" }],
      expected: "alpha\r\nbeta\nGAMMA\n",
    },
    {
      name: "keeps untouched lines between two separate edits",
      original: "one\r\ntwo\nthree\r75%\rfour\nfive\r\n",
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "five", newText: "FIVE" },
      ],
      expected: "ONE\r\ntwo\nthree\r75%\rfour\nFIVE\r\n",
    },
    {
      name: "writes inserted lines with the terminator of the replaced line",
      original: "alpha\r\nbeta\r\ngamma\r\n",
      edits: [{ oldText: "beta", newText: "beta1\nbeta2" }],
      expected: "alpha\r\nbeta1\r\nbeta2\r\ngamma\r\n",
    },
    {
      name: "leaves a uniform CRLF file uniform",
      original: "alpha\r\nbeta\r\ngamma\r\n",
      edits: [{ oldText: "beta", newText: "BETA" }],
      expected: "alpha\r\nBETA\r\ngamma\r\n",
    },
    {
      name: "leaves a uniform LF file uniform",
      original: "alpha\nbeta\ngamma\n",
      edits: [{ oldText: "beta", newText: "BETA" }],
      expected: "alpha\nBETA\ngamma\n",
    },
  ];

  for (const testCase of lineEndingCases) {
    it(testCase.name, async () => {
      const filePath = await createTempFile(testCase.original);
      const tool = createEditTool(tmpDir);

      const result = await tool.execute(
        "call-line-endings",
        { path: filePath, edits: testCase.edits },
        undefined,
      );

      const first = expectDefined(result.content[0], "result.content[0] test invariant");
      expect("text" in first ? first.text : "").toContain("Successfully replaced");
      await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(testCase.expected);
    });
  }

  it("preserves a lone carriage return on an edited line", async () => {
    const filePath = await createTempFile("start\nprogress 10%\rprogress 50%\ndone\n");
    const tool = createEditTool(tmpDir);

    await tool.execute(
      "call-cr-line",
      {
        path: filePath,
        edits: [{ oldText: "progress 50%", newText: "progress 90%" }],
      },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
      "start\nprogress 10%\rprogress 90%\ndone\n",
    );
  });
});
