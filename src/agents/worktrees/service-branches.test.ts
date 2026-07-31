import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

describe("ManagedWorktreeService branch discovery", () => {
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-branches-", await fs.realpath(os.tmpdir()));
    const template = path.join(root, "git-template");
    repo = path.join(root, "repo");
    await fs.mkdir(path.join(template, "hooks"), { recursive: true });
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main", `--template=${template}`);
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports Git, plain-directory, and unavailable repository status", async () => {
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await expect(
      service.listRepositoryBranches(nested, { includeRepositoryStatus: true }),
    ).resolves.toMatchObject({ repositoryStatus: "git" });

    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    await expect(
      service.listRepositoryBranches(plain, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "not_git" });
    await expect(service.listRepositoryBranches(plain)).rejects.toThrow("not a git checkout");

    const malformed = path.join(root, "malformed");
    await fs.mkdir(malformed);
    await fs.writeFile(path.join(malformed, ".git"), "not a gitdir pointer\n");
    await expect(
      service.listRepositoryBranches(malformed, { includeRepositoryStatus: true }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });
    await expect(
      service.listRepositoryBranches(path.join(root, "missing"), {
        includeRepositoryStatus: true,
      }),
    ).resolves.toEqual({ branches: [], repositoryStatus: "unavailable" });
  });
});
