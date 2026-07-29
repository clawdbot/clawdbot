// Verifies Windows drive-letter paths are treated as absolute under POSIX hosts.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createHostWorkspaceWriteTool,
  wrapToolMemoryFlushAppendOnlyWrite,
} from "./agent-tools.read.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

describe("resolveSandboxInputPath (Windows drive paths under POSIX rules)", () => {
  it("does not join workspace cwd when path looks like a Windows drive path", () => {
    const cwd = path.resolve("/workspace/project");
    const resolved = resolveSandboxInputPath("C:/Users/test/file.txt", cwd);
    expect(resolved).toBe(path.win32.normalize("C:/Users/test/file.txt"));
    expect(resolved).not.toContain("workspace");
  });

  it("treats backslash Windows drive paths as absolute vs cwd", () => {
    const cwd = path.resolve("/app/sandbox");
    const resolved = resolveSandboxInputPath("D:\\data\\out.log", cwd);
    expect(resolved).toBe(path.win32.normalize("D:\\data\\out.log"));
    expect(resolved).not.toContain("sandbox");
  });
});

describe("memory-flush write paths (Windows drive paths)", () => {
  const root = path.resolve("/host/workspace");

  it("rejects drive-letter paths outside the retained production write boundary", async () => {
    const drivePath = "C:/temp/agent-output.txt";
    const normalizeWindowsPath = vi.spyOn(path.win32, "normalize");
    const writeTool = wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(root), {
      root,
      relativePath: "memory.md",
    });

    try {
      await expect(
        writeTool.execute("windows-drive-path", {
          path: drivePath,
          content: "must stay outside the workspace",
        }),
      ).rejects.toThrow(/Memory flush writes are restricted to memory\.md/);
      expect(normalizeWindowsPath).toHaveBeenCalledWith(drivePath);
    } finally {
      normalizeWindowsPath.mockRestore();
    }
  });
});
