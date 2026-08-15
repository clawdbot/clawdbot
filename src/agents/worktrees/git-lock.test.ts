import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { lockState, lockWorktreeForProcess } from "./git-lock.js";
import { listGitWorktrees } from "./git.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

/** A pid that has exited, so isPidDefinitelyDead reports ESRCH for it. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "close");
  if (pid === undefined) {
    throw new Error("failed to spawn probe process");
  }
  return pid;
}

async function lockedReason(repoRoot: string, worktreePath: string): Promise<string | undefined> {
  const entries = await listGitWorktrees(repoRoot);
  return entries.find((entry) => path.resolve(entry.path) === path.resolve(worktreePath))
    ?.lockedReason;
}

describe("lockWorktreeForProcess", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function setupWorktree(): Promise<ManagedWorktreeRecord> {
    const root = await fs.realpath(tempDirs.make("openclaw-git-lock-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const worktreePath = path.join(root, "wt-lock");
    await git(repo, "worktree", "add", "-b", "wt-lock", worktreePath, "HEAD");
    return {
      id: "wt-lock",
      name: "wt-lock",
      repoFingerprint: "fingerprint",
      repoRoot: repo,
      path: worktreePath,
      branch: "wt-lock",
      baseRef: "main",
      ownerKind: "session",
      createdAt: 0,
      lastActiveAt: 0,
    };
  }

  it("reclaims a lock left behind by a dead OpenClaw process", async () => {
    const record = await setupWorktree();
    const stalePid = await exitedPid();
    await git(
      record.repoRoot,
      "worktree",
      "lock",
      "--reason",
      `openclaw pid=${stalePid}`,
      record.path,
    );
    expect(await lockState(record)).toEqual({ kind: "dead", pid: stalePid });

    await expect(lockWorktreeForProcess(record)).resolves.toBeUndefined();

    expect(await lockedReason(record.repoRoot, record.path)).toBe(`openclaw pid=${process.pid}`);
  });

  it("keeps a lock held by a live OpenClaw process", async () => {
    const record = await setupWorktree();
    // The parent process is alive and is not this process, so the lock must stand.
    const livePid = process.ppid;
    await git(
      record.repoRoot,
      "worktree",
      "lock",
      "--reason",
      `openclaw pid=${livePid}`,
      record.path,
    );

    await expect(lockWorktreeForProcess(record)).rejects.toThrow(/git worktree lock/);

    expect(await lockedReason(record.repoRoot, record.path)).toBe(`openclaw pid=${livePid}`);
  });

  it("keeps a foreign lock that OpenClaw does not own", async () => {
    const record = await setupWorktree();
    await git(record.repoRoot, "worktree", "lock", "--reason", "held by hand", record.path);

    await expect(lockWorktreeForProcess(record)).rejects.toThrow(/git worktree lock/);

    expect(await lockedReason(record.repoRoot, record.path)).toBe("held by hand");
  });

  it("is idempotent for a lock this process already holds", async () => {
    const record = await setupWorktree();
    await lockWorktreeForProcess(record);

    await expect(lockWorktreeForProcess(record)).resolves.toBeUndefined();

    expect(await lockedReason(record.repoRoot, record.path)).toBe(`openclaw pid=${process.pid}`);
  });
});
