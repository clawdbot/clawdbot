import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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

function requireProofPath(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

describe("Windows MSYS2 Git drive-root proof", () => {
  let repo: string;
  let linked: string;
  let backup: string;
  let stateDir: string;
  let head: string;
  let service: ManagedWorktreeService;

  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    repo = requireProofPath("OPENCLAW_MSYS_PROOF_ROOT");
    linked = requireProofPath("OPENCLAW_MSYS_PROOF_LINKED");
    backup = requireProofPath("OPENCLAW_MSYS_PROOF_BACKUP");
    stateDir = requireProofPath("OPENCLAW_MSYS_PROOF_STATE");
    const template = path.join(path.dirname(linked), "empty-template");
    await fs.mkdir(template, { recursive: true });
    await git(repo, "init", "-b", "main", `--template=${template}`);
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "MSYS drive-root boundary proof\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "MSYS drive-root proof");
    head = await git(repo, "rev-parse", "HEAD");
    await git(repo, "worktree", "add", "-b", "linked-proof", "--", linked, "HEAD");
    await git(repo, "worktree", "lock", "--reason", "external proof lock", linked);
    const gitRoot = await git(repo, "rev-parse", "--show-toplevel");
    expect(gitRoot).toBe("/r");
    console.log(`MSYS_DRIVE_ROOT_RAW=${gitRoot}`);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  }, 60_000);

  afterAll(async () => {
    await fs.rm(linked, { recursive: true, force: true });
  });

  it("resolves drive-root primary and different-drive linked checkout identities", async () => {
    const branches = await service.listRepositoryBranches(repo);
    expect(branches.branches).toEqual(expect.arrayContaining([{ name: "main", kind: "local" }]));
    const primaryIdentity = await service.resolveRepositoryIdentity(repo);
    const linkedIdentity = await service.resolveRepositoryIdentity(linked);
    expect(primaryIdentity.repoRoot).toBe(await fs.realpath(repo));
    expect(linkedIdentity.repoRoot).toBe(primaryIdentity.repoRoot);
    expect(linkedIdentity.checkoutRoot).toBe(await fs.realpath(linked));
    expect(linkedIdentity.fingerprint).toBe(primaryIdentity.fingerprint);
    console.log("MSYS_WORKTREE_IDENTITY_PROOF=passed");
  });

  it("preserves literal revisions, native paths, and lock reasons", async () => {
    const headProbe = await runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    expect(headProbe.code).toBe(0);
    expect(headProbe.stdout.trim()).toBe(head);
    const entries = await listGitWorktrees(repo);
    const linkedEntry = entries.find(
      (entry) => path.resolve(entry.path).toLowerCase() === path.resolve(linked).toLowerCase(),
    );
    expect(linkedEntry?.lockedReason).toBe("external proof lock");
    expect(linkedEntry?.path).toMatch(/^[A-Za-z]:[\\/]/);
    expect(await fs.realpath(linkedEntry!.path)).toBe(await fs.realpath(linked));
    console.log("MSYS_HEAD_AND_PORCELAIN_LOCK_PROOF=passed");
  });

  it("reads backup history through the drive-root repository check", async () => {
    const entries = await readGitBackupLog({ repositoryPath: repo, limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ commit: head, message: "MSYS drive-root proof" });
    console.log("MSYS_BACKUP_LOG_PROOF=passed");
  });

  it("initializes a drive-root private backup without bypassing Windows ACL checks", async () => {
    const result = await initializeGitBackupRepository({
      repositoryPath: backup,
      stateDir,
    });
    expect(result.repositoryPath).toBe(backup);
    await expect(readGitBackupLog({ repositoryPath: backup, limit: 10 })).resolves.toEqual([]);
    console.log("MSYS_BACKUP_INITIALIZE_ACL_PROOF=passed");
  });
});
