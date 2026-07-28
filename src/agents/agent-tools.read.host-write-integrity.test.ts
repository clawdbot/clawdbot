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

  it.each([
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
  ])("keeps the original file when $name cannot finish writing", async ({ createTool, input }) => {
    const originalContent = `original\n${"important content\n".repeat(64)}`;
    const filePath = await createFile(originalContent);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (String(target).includes(".openclaw-host-write.")) {
        handle.writeFile = async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        };
      }
      return handle;
    });

    const tool = createTool(tempDir);
    await expect(tool.execute("call-1", input(filePath))).rejects.toThrow("disk full");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
    await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt"]);
  });

  it.runIf(process.platform !== "win32")("preserves the target inode and its metadata", async () => {
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

  it.runIf(asUnprivilegedUser)("writes when the directory rejects a staged file", async () => {
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

  it.runIf(process.platform !== "win32")("writes through to a non-regular target", async () => {
    await createFile("original");
    const linkPath = path.join(tempDir, "null-link");
    await fs.symlink("/dev/null", linkPath);

    const tool = createHostWorkspaceWriteTool(tempDir);
    await tool.execute("call-1", { path: linkPath, content: "replacement" });

    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect((await fs.stat("/dev/null")).isCharacterDevice()).toBe(true);
    const devEntries = await fs.readdir("/dev");
    expect(devEntries.filter((entry) => entry.startsWith(".openclaw-host-write."))).toEqual([]);
  });
});
