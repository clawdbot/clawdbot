import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
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

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced text in ${filePath}.`,
    });
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

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced text in ${filePath}.`,
    });
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

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced 2 block(s) in ${filePath}.`,
    });
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

      expect(result).toMatchObject({ isError: false });
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Successfully replaced text in ~/demo.txt.",
      });
      await expect(fs.access(path.join(openclawHome, "demo.txt"))).rejects.toBeDefined();
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

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced text in ${filePath}.`,
    });
  });
});
