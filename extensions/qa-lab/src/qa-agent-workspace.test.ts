// Qa Lab tests cover qa agent workspace plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(cleanup);

describe("seedQaAgentWorkspace", () => {
  it.each([
    ["win32", "junction"],
    ["linux", "dir"],
    ["darwin", "dir"],
  ] as const)("uses the expected repo link type on %s", async (platform, linkType) => {
    const workspaceDir = await makeTempDir("qa-workspace-link-type-");
    const repoRoot = await makeTempDir("qa-repo-link-type-");
    const originalPlatform = process.platform;
    const symlink = vi.spyOn(fs, "symlink").mockResolvedValue(undefined);
    Object.defineProperty(process, "platform", { value: platform });
    try {
      await seedQaAgentWorkspace({ workspaceDir, repoRoot });
      expect(symlink).toHaveBeenCalledWith(repoRoot, path.join(workspaceDir, "repo"), linkType);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      symlink.mockRestore();
    }
  });

  it("creates a repo symlink when a repo root is provided", async () => {
    const workspaceDir = await makeTempDir("qa-workspace-");
    const repoRoot = await makeTempDir("qa-repo-");
    await fs.writeFile(path.join(repoRoot, "README.md"), "repo marker\n", "utf8");

    await seedQaAgentWorkspace({ workspaceDir, repoRoot });

    const repoLinkPath = path.join(workspaceDir, "repo");
    const stat = await fs.lstat(repoLinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(repoLinkPath, "README.md"), "utf8")).toBe("repo marker\n");
  });
});
