import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } from "./agent-tools.read.js";

describe("unrestricted host tool writes", () => {
  let tempDir = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  async function createFile(content: string) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-write-"));
    const filePath = path.join(tempDir, "important.txt");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  function failExtensionWrites(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const result = await realWrite(buffer, offset, length, position);
          if (position >= originalByteLength) {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return result;
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function failPrefixWrites(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        let failed = false;
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (!failed && position < originalByteLength) {
            failed = true;
            await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return realWrite(buffer, offset, length, position);
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function failShrinkTruncate(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realTruncate = handle.truncate.bind(handle);
        handle.truncate = (async (length: number) => {
          if (length < originalByteLength) {
            throw Object.assign(new Error("truncate failed"), { code: "EIO" });
          }
          return realTruncate(length);
        }) as typeof handle.truncate;
      }
      return handle;
    });
  }

  function failTargetInspection(filePath: string) {
    const realMkdir = fs.mkdir.bind(fs);
    const realStat = fs.stat.bind(fs);
    let reachedWriter = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      reachedWriter = true;
      return realMkdir(target, options as never);
    });
    vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
      if (reachedWriter && String(target) === filePath) {
        throw Object.assign(new Error("inspect failed"), { code: "EIO" });
      }
      return realStat(target, options as never);
    });
  }

  const hostWriteToolCases = [
    {
      name: "write",
      createTool: (root: string) => createHostWorkspaceWriteTool(root),
      input: (filePath: string) => ({
        path: filePath,
        content: "replacement content\n".repeat(64),
      }),
    },
    {
      name: "edit",
      createTool: (root: string) => createHostWorkspaceEditTool(root),
      input: (filePath: string) => ({
        path: filePath,
        edits: [{ oldText: "original", newText: "replacement" }],
      }),
    },
  ];

  it.each(hostWriteToolCases)(
    "keeps the original file when $name cannot finish writing",
    async ({ createTool, input }) => {
      const originalContent = `original\n${"important content\n".repeat(64)}`;
      const filePath = await createFile(originalContent);
      failExtensionWrites(filePath, Buffer.byteLength(originalContent));

      const tool = createTool(tempDir);
      await expect(tool.execute("call-1", input(filePath))).rejects.toThrow("disk full");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
      await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt"]);
    },
  );

  it.each(hostWriteToolCases)(
    "restores the original when $name fails partway through the prefix overwrite",
    async ({ createTool, input }) => {
      const originalContent = `original\n${"important content\n".repeat(64)}`;
      const filePath = await createFile(originalContent);
      failPrefixWrites(filePath, Buffer.byteLength(originalContent));

      const tool = createTool(tempDir);
      await expect(tool.execute("call-1", input(filePath))).rejects.toThrow("disk full");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
      await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt"]);
    },
  );

  it.each(hostWriteToolCases)(
    "keeps the original file when $name cannot inspect the target",
    async ({ createTool, input }) => {
      const originalContent = `original\n${"important content\n".repeat(64)}`;
      const filePath = await createFile(originalContent);
      failTargetInspection(filePath);
      const fallback = vi.spyOn(fs, "writeFile");

      const tool = createTool(tempDir);
      await expect(tool.execute("call-1", input(filePath))).rejects.toMatchObject({ code: "EIO" });

      expect(fallback).not.toHaveBeenCalled();
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
    },
  );

  const hostShrinkToolCases = [
    {
      name: "write",
      createTool: (root: string) => createHostWorkspaceWriteTool(root),
      input: (filePath: string) => ({ path: filePath, content: "short\n" }),
    },
    {
      name: "edit",
      createTool: (root: string) => createHostWorkspaceEditTool(root),
      input: (filePath: string) => ({
        path: filePath,
        edits: [{ oldText: "original", newText: "changed" }],
      }),
    },
  ];

  it.each(hostShrinkToolCases)(
    "restores the original when $name cannot truncate the stale tail",
    async ({ createTool, input }) => {
      const originalContent = `original\n${"important content\n".repeat(64)}`;
      const filePath = await createFile(originalContent);
      failShrinkTruncate(filePath, Buffer.byteLength(originalContent));

      const tool = createTool(tempDir);
      await expect(tool.execute("call-1", input(filePath))).rejects.toThrow("truncate failed");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
      await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt"]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves the target inode and its metadata",
    async () => {
      const filePath = await createFile("original");
      await fs.chmod(filePath, 0o640);
      const before = await fs.stat(filePath);

      const tool = createHostWorkspaceWriteTool(tempDir);
      await tool.execute("call-1", { path: filePath, content: "replacement" });

      const after = await fs.stat(filePath);
      expect(after.ino).toBe(before.ino);
      expect(after.dev).toBe(before.dev);
      expect(after.mode & 0o777).toBe(0o640);
      expect(after.uid).toBe(before.uid);
      expect(after.gid).toBe(before.gid);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
      await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt"]);
    },
  );

  it("truncates the tail when new content is shorter", async () => {
    const filePath = await createFile(`header\n${"stale tail line\n".repeat(32)}`);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: filePath, content: "short\n" });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("short\n");
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("writes %s content", async (_label, content) => {
    const filePath = await createFile("replace me\n");

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: filePath, content });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
  });

  it("truncates to empty when an edit removes all content", async () => {
    const filePath = await createFile("wipe me\n");

    const tool = createHostWorkspaceEditTool(tempDir);
    await tool.execute("call-1", {
      path: filePath,
      edits: [{ oldText: "wipe me\n", newText: "" }],
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("");
  });

  it("writes multi-byte content that splits at the old file boundary", async () => {
    const filePath = await createFile("abcde");
    const content = "héllo crab 🦀 héllo\n";

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: filePath, content });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
  });

  it("creates a missing file in a missing directory", async () => {
    await createFile("existing");
    const filePath = path.join(tempDir, "nested", "fresh.txt");

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: filePath, content: "fresh" });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("fresh");
  });

  it.runIf(process.platform !== "win32")("writes through an existing symlink", async () => {
    const targetPath = await createFile("original");
    const linkPath = path.join(tempDir, "linked.txt");
    await fs.symlink(targetPath, linkPath);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: linkPath, content: "replacement" });

    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement");
  });

  const asUnprivilegedUser = process.platform !== "win32" && process.getuid?.() !== 0;

  it.runIf(asUnprivilegedUser)("rejects a non-writable existing file", async () => {
    const filePath = await createFile("original");
    await fs.chmod(filePath, 0o444);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await expect(
      tool.execute("call-1", { path: filePath, content: "replacement" }),
    ).rejects.toMatchObject({ code: "EACCES" });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("original");
  });

  it.runIf(asUnprivilegedUser)("rejects an unreadable existing file", async () => {
    const originalContent = "original\n";
    const filePath = await createFile(originalContent);
    await fs.chmod(filePath, 0o222);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await expect(
      tool.execute("call-1", { path: filePath, content: "replacement" }),
    ).rejects.toMatchObject({ code: "EACCES" });

    await fs.chmod(filePath, 0o644);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
  });

  it.runIf(asUnprivilegedUser)("writes a file inside a read-only directory", async () => {
    const filePath = await createFile("original");
    await fs.chmod(tempDir, 0o500);

    try {
      const tool = createHostWorkspaceWriteTool(tempDir);
      await tool.execute("call-1", { path: filePath, content: "replacement" });
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
    } finally {
      await fs.chmod(tempDir, 0o700);
    }
  });

  it.runIf(process.platform !== "win32")("updates a hard-linked existing file", async () => {
    const filePath = await createFile("original");
    const aliasPath = path.join(tempDir, "alias.txt");
    await fs.link(filePath, aliasPath);
    const before = await fs.stat(filePath);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: filePath, content: "replacement" });

    const after = await fs.stat(filePath);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(2);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(aliasPath, "utf8")).resolves.toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "passes a non-regular target through unchanged",
    async () => {
      await createFile("original");
      const linkPath = path.join(tempDir, "null-link");
      await fs.symlink("/dev/null", linkPath);

      const tool = createHostWorkspaceWriteTool(tempDir);
      await expect(
        tool.execute("call-1", { path: linkPath, content: "replacement" }),
      ).rejects.toThrow("Write verification failed");

      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect((await fs.stat("/dev/null")).isCharacterDevice()).toBe(true);
      await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt", "null-link"]);
    },
  );

  it.runIf(process.platform !== "win32")("falls back to a fifo without opening it", async () => {
    await createFile("original");
    const fifoPath = path.join(tempDir, "pipe");
    execFileSync("mkfifo", [fifoPath]);
    const fifoOpenFlags: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      if (String(target) === fifoPath) {
        fifoOpenFlags.push(String(flags));
      }
      return realOpen(target, flags as never, mode as never);
    });
    const fallback = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: fifoPath, content: "replacement" }).catch(() => undefined);

    expect(fallback).toHaveBeenCalledWith(fifoPath, "replacement", "utf-8");
    expect(fifoOpenFlags).toEqual([]);
  });
});
