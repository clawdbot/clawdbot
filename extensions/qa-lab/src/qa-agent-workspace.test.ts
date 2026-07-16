import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedQaAgentWorkspace } from "./qa-agent-workspace.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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
