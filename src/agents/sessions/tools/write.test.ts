// Write tool tests cover session path resolution and post-write recovery when
// remote or sandbox operations fail after persisting content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
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
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("hello\n");
  });

  it("writes different content successfully (no false positive for no-op)", async () => {
    const filePath = await createTempPath("different.txt");
    const content = "new 😀\n";
    await fs.writeFile(filePath, "old\n", "utf-8");
    const tool = createWriteTool(tmpDir);

    const result = await tool.execute("call-1", { path: "different.txt", content }, undefined);

    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to different.txt`,
    });
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(content);
  });
});
