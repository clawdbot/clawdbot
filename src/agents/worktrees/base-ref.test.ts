import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveWorktreeBase } from "./base-ref.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("resolveWorktreeBase", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worktree-base-");
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
  });

  it("uses local HEAD when the repository has no origin", async () => {
    await expect(resolveWorktreeBase(repo)).resolves.toEqual({
      gitOperand: "HEAD",
      recordRef: "HEAD",
      remote: false,
    });
  });

  it("fails visibly when origin cannot be refreshed", async () => {
    await git(repo, "remote", "add", "origin", path.join(root, "missing.git"));
    await expect(resolveWorktreeBase(repo)).rejects.toThrow(
      /git fetch origin.*choose a base branch explicitly/s,
    );
  });

  it("refreshes origin HEAD when the remote default branch changes", async () => {
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["clone", "--bare", repo, remote]);
    await git(repo, "remote", "add", "origin", remote);

    await expect(resolveWorktreeBase(repo)).resolves.toEqual({
      gitOperand: "origin/main",
      recordRef: "origin/main",
      remote: true,
    });

    await git(repo, "branch", "next");
    await git(repo, "push", "origin", "next");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/next");

    await expect(resolveWorktreeBase(repo)).resolves.toEqual({
      gitOperand: "origin/next",
      recordRef: "origin/next",
      remote: true,
    });
    await expect(git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).resolves.toBe(
      "origin/next",
    );
  });

  it("fails visibly when origin has no default branch", async () => {
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["clone", "--bare", repo, remote]);
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/missing");
    await git(repo, "remote", "add", "origin", remote);

    await expect(resolveWorktreeBase(repo)).rejects.toThrow(
      "Set origin/HEAD or choose a base branch explicitly",
    );
  });
});
