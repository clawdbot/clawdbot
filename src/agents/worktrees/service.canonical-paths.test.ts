import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";
import { initializeManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("ManagedWorktreeService canonical paths", () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-canonical-paths-"),
    );
    repo = await initializeManagedWorktreeTestRepository(root);
    stateDir = path.join(root, "state");
    await fs.mkdir(stateDir, { recursive: true });
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps registry operations anchored to the primary checkout", async () => {
    const linked = path.join(root, "linked-source");
    await git(repo, "worktree", "add", "-b", "linked-source", linked, "HEAD");
    const linkedRoot = await fs.realpath(linked);
    const created = await service.create({
      repoRoot: linkedRoot,
      name: "linked-task",
      baseRef: "HEAD",
    });
    expect(created.repoRoot).toBe(repo);
    await git(repo, "worktree", "remove", "--force", linkedRoot);

    await service.acquire(created.id);
    await service.release(created.id);
    await service.remove({ id: created.id, reason: "linked-source-removed" });
    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\n");
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes managed paths minted below a symlinked state directory",
    async () => {
      const realStateDir = await fs.mkdtemp(path.join(root, "real-state-"));
      const linkedStateDir = path.join(root, "linked-state");
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      const linkedStateService = new ManagedWorktreeService({
        env: { ...process.env, OPENCLAW_STATE_DIR: linkedStateDir },
      });

      const created = await linkedStateService.create({
        repoRoot: repo,
        name: "canonical-state",
        baseRef: "HEAD",
      });
      const expectedPath = path.join(
        await fs.realpath(realStateDir),
        "worktrees",
        created.repoFingerprint,
        "canonical-state",
      );
      expect(created.path).toBe(expectedPath);

      await linkedStateService.acquire(created.id);
      await expect(linkedStateService.removeIfLossless(created.id)).resolves.toBe(true);
      await expect(fs.stat(expectedPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
