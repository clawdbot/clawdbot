import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapEditToolWithRecovery, wrapWriteToolWithRecovery } from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxFsBridge, SandboxFsStat } from "./sandbox/fs-bridge.js";

function createInMemoryBridge(root: string, files: Map<string, string>): SandboxFsBridge {
  const resolveAbsolute = (filePath: string, cwd?: string) =>
    path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd ?? root, filePath);

  const readStat = (absolutePath: string): SandboxFsStat | null => {
    const content = files.get(absolutePath);
    if (typeof content !== "string") {
      return null;
    }
    return {
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
      mtimeMs: 0,
    };
  };

  return {
    resolvePath: ({ filePath, cwd }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      return {
        hostPath: absolutePath,
        relativePath: path.relative(root, absolutePath),
        containerPath: absolutePath,
      };
    },
    readFile: async ({ filePath, cwd }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      const content = files.get(absolutePath);
      if (typeof content !== "string") {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return Buffer.from(content, "utf8");
    },
    writeFile: async ({ filePath, cwd, data }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      files.set(absolutePath, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    mkdirp: async () => {},
    remove: async ({ filePath, cwd }) => {
      files.delete(resolveAbsolute(filePath, cwd));
    },
    rename: async ({ from, to, cwd }) => {
      const fromPath = resolveAbsolute(from, cwd);
      const toPath = resolveAbsolute(to, cwd);
      const content = files.get(fromPath);
      if (typeof content !== "string") {
        throw new Error(`ENOENT: ${fromPath}`);
      }
      files.set(toPath, content);
      files.delete(fromPath);
    },
    stat: async ({ filePath, cwd }) => readStat(resolveAbsolute(filePath, cwd)),
  };
}

describe("edit tool recovery hardening", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  function createRecoveredEditTool(params: {
    root: string;
    readFile: (absolutePath: string) => Promise<string>;
    execute: AnyAgentTool["execute"];
  }) {
    const base = {
      name: "edit",
      execute: params.execute,
    } as unknown as AnyAgentTool;
    return wrapEditToolWithRecovery(base, {
      root: params.root,
      readFile: params.readFile,
    });
  }

  function expectRecoveredText(result: Awaited<ReturnType<AnyAgentTool["execute"]>>, text: string) {
    expect((result as { isError?: unknown }).isError).toBe(false);
    const first = result.content[0];
    expect(first?.type).toBe("text");
    expect(first?.type === "text" ? first.text : undefined).toBe(text);
  }

  async function expectPathMissing(targetPath: string) {
    try {
      await fs.access(targetPath);
      throw new Error(`expected ${targetPath} to be missing`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      expect(code).toBe("ENOENT");
    }
  }

  it("adds current file contents to exact-match mismatch errors", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "actual current content", "utf-8");

    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        throw new Error(
          "Could not find the exact text in demo.txt. The old text must match exactly including all whitespace and newlines.",
        );
      },
    });
    await expect(
      tool.execute(
        "call-1",
        { path: filePath, edits: [{ oldText: "missing", newText: "replacement" }] },
        undefined,
      ),
    ).rejects.toThrow(/Current file contents:\nactual current content/);
  });

  it("recovers success after a post-write throw when CRLF output contains newText and oldText is only a substring", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, 'const value = "foo";\r\n', "utf-8");

    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        await fs.writeFile(filePath, 'const value = "foobar";\r\n', "utf-8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
    });
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

    expectRecoveredText(result, `Successfully replaced text in ${filePath}.`);
  });

  it("recovers post-write failures when edit calls use file_path", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const workspaceDir = path.join(tmpDir, ".openclaw", "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(filePath, "# Agent\nold instruction\n", "utf-8");

    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        await fs.writeFile(filePath, "# Agent\nnew instruction\n", "utf-8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
    });
    const result = await tool.execute(
      "call-1",
      {
        file_path: filePath,
        edits: [{ oldText: "old instruction", newText: "new instruction" }],
      },
      undefined,
    );

    expectRecoveredText(result, `Successfully replaced text in ${filePath}.`);
  });

  it("does not recover false success when the file never changed", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "replacement already present", "utf-8");

    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
    });
    await expect(
      tool.execute(
        "call-1",
        {
          path: filePath,
          edits: [{ oldText: "missing", newText: "replacement already present" }],
        },
        undefined,
      ),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("recovers deletion edits when the file changed and oldText is gone", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "before delete me after\n", "utf-8");

    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        await fs.writeFile(filePath, "before  after\n", "utf-8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
    });
    const result = await tool.execute(
      "call-1",
      { path: filePath, edits: [{ oldText: "delete me", newText: "" }] },
      undefined,
    );

    expectRecoveredText(result, `Successfully replaced text in ${filePath}.`);
  });

  it("recovers multi-edit payloads after a post-write throw", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "alpha beta gamma delta\n", "utf-8");

    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        await fs.writeFile(filePath, "ALPHA beta gamma DELTA\n", "utf-8");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
    });
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

    expectRecoveredText(result, `Successfully replaced 2 block(s) in ${filePath}.`);
  });

  it("recovers tilde paths against the OS home even when OPENCLAW_HOME differs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const osHome = path.join(tmpDir, "home");
    const openclawHome = path.join(tmpDir, "openclaw-home");
    await fs.mkdir(osHome, { recursive: true });
    await fs.mkdir(openclawHome, { recursive: true });

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.HOME = osHome;
    process.env.USERPROFILE = osHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      const filePath = path.join(osHome, "demo.txt");
      await fs.writeFile(filePath, "before old text after\n", "utf-8");

      const tool = createRecoveredEditTool({
        root: tmpDir,
        readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
        execute: async () => {
          await fs.writeFile(filePath, "before new text after\n", "utf-8");
          throw new Error("Simulated post-write failure (e.g. generateDiffString)");
        },
      });
      const result = await tool.execute(
        "call-1",
        { path: "~/demo.txt", edits: [{ oldText: "old text", newText: "new text" }] },
        undefined,
      );

      expectRecoveredText(result, "Successfully replaced text in ~/demo.txt.");
      await expectPathMissing(path.join(openclawHome, "demo.txt"));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      if (previousOpenclawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenclawHome;
      }
    }
  });

  it("applies the same recovery path to sandboxed edit tools", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const files = new Map<string, string>([[filePath, "before old text after\n"]]);

    const bridge = createInMemoryBridge(tmpDir, files);
    const tool = createRecoveredEditTool({
      root: tmpDir,
      readFile: async (absolutePath: string) =>
        (await bridge.readFile({ filePath: absolutePath, cwd: tmpDir })).toString("utf8"),
      execute: async () => {
        files.set(filePath, "before new text after\n");
        throw new Error("Simulated post-write failure (e.g. generateDiffString)");
      },
    });
    const result = await tool.execute(
      "call-1",
      { path: filePath, edits: [{ oldText: "old text", newText: "new text" }] },
      undefined,
    );

    expectRecoveredText(result, `Successfully replaced text in ${filePath}.`);
  });
});

describe("write tool recovery hardening", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  function createRecoveredWriteTool(params: {
    root: string;
    readFile: (absolutePath: string) => Promise<string>;
    statFile?: Parameters<typeof wrapWriteToolWithRecovery>[1]["statFile"];
    execute: AnyAgentTool["execute"];
  }) {
    const base = {
      name: "write",
      execute: params.execute,
    } as unknown as AnyAgentTool;
    return wrapWriteToolWithRecovery(base, {
      root: params.root,
      readFile: params.readFile,
      statFile:
        params.statFile ??
        (async (absolutePath) => {
          try {
            const stat = await fs.stat(absolutePath);
            return {
              type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            };
          } catch (err) {
            if (
              err &&
              typeof err === "object" &&
              "code" in err &&
              (err as { code?: unknown }).code === "ENOENT"
            ) {
              return null;
            }
            throw err;
          }
        }),
    });
  }

  it("recovers success after a post-write abort when readback matches requested content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const controller = new AbortController();

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async (_toolCallId, params) => {
        const record = params as { path: string; content: string };
        await fs.writeFile(record.path, record.content, "utf-8");
        controller.abort();
        throw new Error("Operation aborted");
      },
    });
    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "finished\n" },
      controller.signal,
    );

    expect((result as { isError?: unknown }).isError).toBe(false);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Successfully wrote ${"finished\n".length} bytes to ${filePath}`,
    });
  });

  it("keeps the original abort when readback does not match requested content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const controller = new AbortController();

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        await fs.writeFile(filePath, "partial\n", "utf-8");
        controller.abort();
        throw new Error("Operation aborted");
      },
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "finished\n" }, controller.signal),
    ).rejects.toThrow("Operation aborted");
  });

  it("keeps the original abort when the file already matched before execution", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "finished\n", "utf-8");
    const controller = new AbortController();
    controller.abort();

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async () => {
        throw new Error("Operation aborted");
      },
    });

    await expect(
      tool.execute("call-1", { path: filePath, content: "finished\n" }, controller.signal),
    ).rejects.toThrow("Operation aborted");
  });

  it("does not pre-read large same-size files on successful writes", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "large.txt");
    const content = "x".repeat(1024 * 1024 + 1);
    const readFile = vi.fn(async () => {
      throw new Error("readFile should not run on the success path");
    });

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile,
      statFile: async () => ({ type: "file", size: Buffer.byteLength(content, "utf8") }),
      execute: async () =>
        ({
          isError: false,
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        }) as AgentToolResult<unknown>,
    });

    const result = await tool.execute("call-1", { path: filePath, content }, undefined);

    expect((result as { isError?: unknown }).isError).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("recovers large same-size rewrites when timeout follows changed metadata", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "large.txt");
    const content = "x".repeat(1024 * 1024 + 1);
    const readFile = vi.fn(async () => content);
    let statCall = 0;
    const statFile = vi.fn(async () => {
      statCall += 1;
      return {
        type: "file",
        size: Buffer.byteLength(content, "utf8"),
        mtimeMs: statCall,
      } as const;
    });

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile,
      statFile,
      execute: async () => {
        throw new Error("node invoke timed out");
      },
    });

    const result = await tool.execute("call-1", { path: filePath, content }, undefined);

    expect((result as { isError?: unknown }).isError).toBe(false);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(statFile).toHaveBeenCalledTimes(2);
  });

  it("recovers new-file writes when pre-stat throws before a timeout", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "created.txt");
    const content = "created\n";

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: async () => content,
      statFile: async () => {
        throw new Error("No such file or directory");
      },
      execute: async () => {
        throw new Error("node invoke timed out");
      },
    });

    const result = await tool.execute("call-1", { path: filePath, content }, undefined);

    expect((result as { isError?: unknown }).isError).toBe(false);
  });

  it("keeps timeout when pre-stat fails for an unknown reason", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const content = "already there\n";

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: async () => content,
      statFile: async () => {
        throw new Error("stat bridge failed");
      },
      execute: async () => {
        throw new Error("node invoke timed out");
      },
    });

    await expect(tool.execute("call-1", { path: filePath, content }, undefined)).rejects.toThrow(
      "node invoke timed out",
    );
  });

  it("recovers @-prefixed write paths through the upstream write path contract", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "notes.md");
    const controller = new AbortController();

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async (_toolCallId, params) => {
        const record = params as { content: string };
        await fs.writeFile(filePath, record.content, "utf-8");
        controller.abort();
        throw new Error("Operation aborted");
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "@notes.md", content: "finished\n" },
      controller.signal,
    );

    expect((result as { isError?: unknown }).isError).toBe(false);
  });

  it("recovers timeout-like post-write errors when readback matches requested content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async (_toolCallId, params) => {
        const record = params as { path: string; content: string };
        await fs.writeFile(record.path, record.content, "utf-8");
        throw new Error("node invoke timed out");
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath, content: "finished\n" },
      undefined,
    );

    expect((result as { isError?: unknown }).isError).toBe(false);
  });

  it("recovers file URL write paths through the upstream write path contract", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-recovery-"));
    const filePath = path.join(tmpDir, "notes.md");
    const fileUrl = pathToFileURL(filePath).href;
    const controller = new AbortController();

    const tool = createRecoveredWriteTool({
      root: tmpDir,
      readFile: (absolutePath) => fs.readFile(absolutePath, "utf-8"),
      execute: async (_toolCallId, params) => {
        const record = params as { content: string };
        await fs.writeFile(filePath, record.content, "utf-8");
        controller.abort();
        throw new Error("Operation aborted");
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: fileUrl, content: "finished\n" },
      controller.signal,
    );

    expect((result as { isError?: unknown }).isError).toBe(false);
  });
});
