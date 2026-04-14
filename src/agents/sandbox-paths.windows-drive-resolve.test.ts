import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxInputPath } from "./sandbox-paths.js";
import { resolveToolPathAgainstWorkspaceRoot } from "./pi-tools.read.js";

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

describe("resolveToolPathAgainstWorkspaceRoot (Windows drive paths)", () => {
  const root = path.resolve("/host/workspace");

  it("does not prefix workspace root for drive-letter paths", () => {
    const resolved = resolveToolPathAgainstWorkspaceRoot({
      filePath: "C:/temp/agent-output.txt",
      root,
    });
    expect(resolved).toBe(path.win32.normalize("C:/temp/agent-output.txt"));
    expect(resolved).not.toContain("host");
  });
});
