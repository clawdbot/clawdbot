// Write tool tests cover session path resolution and post-write recovery when
// remote or sandbox operations fail after persisting content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.js";
import { createWriteTool, type WriteOperations } from "./write.js";

describe("write tool", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function createTempPath(name = "demo.txt") {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-tool-"));
    return path.join(tmpDir, name);
  }

  function createRecoverableOperations(writeFile: WriteOperations["writeFile"]): WriteOperations {
    return {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile,
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: async (absolutePath) => {
        try {
          const stat = await fs.stat(absolutePath);
          return {
            type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          } as const;
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: unknown }).code === "ENOENT"
          ) {
            return null;
          }
          throw error;
        }
      },
    };
  }

  it("recovers success after a post-write abort when readback matches requested content", async () => {
    // Remote transports can report cancellation after the write landed; verify
    // by readback before surfacing a false failure to the model.
    const filePath = await createTempPath();
    const expectedContent = "finished 😀\n";
    const controller = new AbortController();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async (absolutePath, content) => {
        await fs.writeFile(absolutePath, content, "utf-8");
        controller.abort();
        throw new Error("Operation aborted");
      }),
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: expectedContent },
      controller.signal,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(expectedContent, "utf8")} bytes to ${filePath}`,
    });
  });

  it("keeps the original abort when the file already matched before execution", async () => {
    // Matching pre-existing content is not proof this call wrote successfully.
    const filePath = await createTempPath();
    await fs.writeFile(filePath, "finished\n", "utf-8");
    const controller = new AbortController();
    controller.abort();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async () => {
        throw new Error("Operation aborted");
      }),
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "finished\n" }, controller.signal),
    ).rejects.toThrow("Operation aborted");
  });

  it("recovers timeout-like post-write errors when readback matches requested content", async () => {
    const filePath = await createTempPath();
    const tool = createWriteTool(tmpDir, {
      operations: createRecoverableOperations(async (absolutePath, content) => {
        await fs.writeFile(absolutePath, content, "utf-8");
        throw new Error("node invoke timed out");
      }),
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "finished\n" },
      undefined,
    );

    expect(result.content[0]?.type).toBe("text");
  });

  it("writes file URL paths through the shared session path resolver", async () => {
    const filePath = await createTempPath("notes.md");
    const tool = createWriteTool(tmpDir);

    await tool.execute(
      "call-1",
      { path: pathToFileURL(filePath).href, content: "finished\n" },
      undefined,
    );

    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("finished\n");
  });

  it("returns terminal no-op when writing identical content to existing file", async () => {
    const filePath = await createTempPath("identical.txt");
    await fs.writeFile(filePath, "hello\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "identical.txt", content: "hello\n" },
      undefined,
    );

    const tc0 = expectDefined(result.content[0], "result.content[0] test invariant");
    expect("text" in tc0 ? tc0.text : "").toContain("No changes made");
    expect((result as { terminate?: boolean }).terminate).toBe(true);
    expect(result.details).toEqual({ changed: false });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("hello\n");
  });

  it("reports a created file with its authoritative diff", async () => {
    await createTempPath("created.txt");
    const content = "first\nsecond\n";
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "created.txt", content }, undefined);
    const diffResult = generateDiffString("", content);

    expect(result.details).toEqual({
      changed: true,
      created: true,
      diff: diffResult.diff,
      patch: generateUnifiedPatch("created.txt", "", content),
      firstChangedLine: diffResult.firstChangedLine,
    });
  });

  it("keeps oversized created-file details bounded", async () => {
    await createTempPath("large-created.txt");
    const content = "x".repeat(1024 * 1024 + 1);
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "large-created.txt", content }, undefined);

    expect(result.details).toEqual({ changed: true, created: true });
  });

  it("reports an overwrite with the readable old-content diff", async () => {
    const filePath = await createTempPath("different.txt");
    const content = "new 😀\n";
    const oldContent = "old\n";
    await fs.writeFile(filePath, oldContent, "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "different.txt", content }, undefined);
    const diffResult = generateDiffString(oldContent, content);

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to different.txt`,
    });
    expect(result.details).toEqual({
      changed: true,
      created: false,
      diff: diffResult.diff,
      patch: generateUnifiedPatch("different.txt", oldContent, content),
      firstChangedLine: diffResult.firstChangedLine,
    });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(content);
  });

  it("omits the diff when the old content is not valid UTF-8 text", async () => {
    const filePath = await createTempPath("binary.bin");
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "binary.bin", content: "text now\n" },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("omits the diff when the rewrite's edit distance blows the budget", async () => {
    const filePath = await createTempPath("distinct-lines.txt");
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `old-${i}`).join("\n");
    await fs.writeFile(filePath, oldContent, "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      {
        path: "distinct-lines.txt",
        content: Array.from({ length: 10_000 }, (_, i) => `new-${i}`).join("\n"),
      },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("omits the diff for created files with excessive line counts", async () => {
    await createTempPath("many-lines-created.txt");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "many-lines-created.txt", content: "a\n".repeat(25_000) },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: true });
  });

  it("omits the diff when combined line counts exceed the diff budget", async () => {
    const filePath = await createTempPath("many-lines.txt");
    await fs.writeFile(filePath, "a\n".repeat(15_000), "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "many-lines.txt", content: "b\n".repeat(15_000) },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("omits the diff when combined old and new content exceeds the diff budget", async () => {
    const filePath = await createTempPath("combined.txt");
    await fs.writeFile(filePath, "a".repeat(600 * 1024), "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "combined.txt", content: "b".repeat(600 * 1024) },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("reports an overwrite without a fabricated diff when the old file is too large", async () => {
    const filePath = await createTempPath("large.txt");
    await fs.writeFile(filePath, "x".repeat(1024 * 1024 + 1), "utf-8");
    let readCalled = false;
    const operations = createRecoverableOperations((absolutePath, content) =>
      fs.writeFile(absolutePath, content, "utf-8"),
    );
    operations.readFile = async () => {
      readCalled = true;
      throw new Error("oversized pre-write read");
    };
    const tool = createWriteTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      { path: "large.txt", content: "replacement\n" },
      undefined,
    );

    expect(readCalled).toBe(false);
    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("keeps oversized overwrite details bounded", async () => {
    const filePath = await createTempPath("large-replacement.txt");
    await fs.writeFile(filePath, "old\n", "utf-8");
    const content = "x".repeat(1024 * 1024 + 1);
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute(
      "call-1",
      { path: "large-replacement.txt", content },
      undefined,
    );

    expect(result.details).toEqual({ changed: true, created: false });
  });

  it("does not guess creation status when the pre-write stat is unavailable", async () => {
    await createTempPath("unknown.txt");
    const operations: WriteOperations = {
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
      writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
      statFile: async () => {
        throw new Error("remote stat unavailable");
      },
    };
    const tool = createWriteTool(tmpDir, { operations });

    const result = await tool.execute(
      "call-1",
      { path: "unknown.txt", content: "new\n" },
      undefined,
    );

    expect(result.details).toEqual({ changed: true });
  });
});
