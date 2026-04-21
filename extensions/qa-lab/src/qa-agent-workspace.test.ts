import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(cleanup);

describe("seedQaAgentWorkspace", () => {
  it("creates a repo symlink when a repo root is provided", async () => {
    const workspaceDir = await makeTempDir("qa-workspace-");
    const repoRoot = await makeTempDir("qa-repo-");
    await fs.writeFile(path.join(repoRoot, "README.md"), "repo marker\n", "utf8");

    await seedQaAgentWorkspace({ workspaceDir, repoRoot });

    const repoLinkPath = path.join(workspaceDir, "repo");
    const stat = await fs.lstat(repoLinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(repoLinkPath, "README.md"), "utf8")).toContain(
      "repo marker",
    );
  });
});
