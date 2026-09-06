import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listGitWorktrees, runGit } from "../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { initializeGitBackupRepository, readGitBackupLog } from "../snapshot/git-backup.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return stdout.trim();
}

describe("Windows MSYS2 Git native filesystem proof", () => {
  let root: string;
  let repo: string;
  let linked: string;
  let head: string;
  let service: ManagedWorktreeService;

  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-msys-proof-"));
    repo = path.join(root, "primary checkout");
    linked = path.join(root, "linked checkout");
    const template = path.join(root, "empty-template");
    await fs.mkdir(repo);
    await fs.mkdir(template);
    await git(repo, "init", "-b", "main", `--template=${template}`);
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "MSYS path boundary proof\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "MSYS path proof");
    head = await git(repo, "rev-parse", "HEAD");
    await git(repo, "worktree", "add", "-b", "linked-proof", "--", linked, "HEAD");
    await git(repo, "worktree", "lock", "--reason", "external proof lock", linked);
    const gitRoot = await git(repo, "rev-parse", "--show-toplevel");
    expect(gitRoot).toMatch(/^\/(?!\/)/);
    expect(gitRoot).not.toBe(repo);
    console.log(
      `MSYS_DEPENDENCY_PROOF ${JSON.stringify({
        nativeRoot: repo,
        gitRoot,
        version: await git(repo, "--version"),
      })}`,
    );
    console.log(
      `MSYS_HEAD_PROBE ${JSON.stringify(
        await runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"]),
      )}`,
    );
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  }, 60_000);

  afterAll(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves primary and linked checkout identities from real MSYS2 Git output", async () => {
    const branches = await service.listRepositoryBranches(repo);
    expect(branches.branches).toEqual(expect.arrayContaining([{ name: "main", kind: "local" }]));
    const primaryIdentity = await service.resolveRepositoryIdentity(repo);
    const linkedIdentity = await service.resolveRepositoryIdentity(linked);
    expect(primaryIdentity.repoRoot).toBe(await fs.realpath(repo));
    expect(linkedIdentity.repoRoot).toBe(primaryIdentity.repoRoot);
    expect(linkedIdentity.checkoutRoot).toBe(await fs.realpath(linked));
    expect(linkedIdentity.fingerprint).toBe(primaryIdentity.fingerprint);
    console.log("MSYS_WORKTREE_IDENTITY_PROOF passed");
  });

  it("preserves native paths and lock reasons from real porcelain output", async () => {
    const entries = await listGitWorktrees(repo);
    const linkedEntry = entries.find(
      (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(linked).toLowerCase(),
    );
    expect(linkedEntry?.lockedReason).toBe("external proof lock");
    expect(linkedEntry?.path).toMatch(/^[A-Za-z]:[\\/]/);
    expect(await fs.realpath(linkedEntry!.path)).toBe(await fs.realpath(linked));
    console.log("MSYS_PORCELAIN_LOCK_PROOF passed");
  });

  it("reads backup history through the real repository-root check", async () => {
    const entries = await readGitBackupLog({ repositoryPath: repo, limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ commit: head, message: "MSYS path proof" });
    console.log("MSYS_BACKUP_LOG_PROOF passed");
  });

  it("initializes a private backup repository without bypassing Windows ACL checks", async () => {
    const repositoryPath = path.join(root, "private backup");
    const result = await initializeGitBackupRepository({
      repositoryPath,
      stateDir: path.join(root, "backup-state"),
    });
    expect(result.repositoryPath).toBe(repositoryPath);
    await expect(readGitBackupLog({ repositoryPath, limit: 10 })).resolves.toEqual([]);
    console.log("MSYS_BACKUP_INITIALIZE_ACL_PROOF passed");
  });
});
