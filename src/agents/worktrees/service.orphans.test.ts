import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { listGitWorktrees } from "./git.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("ManagedWorktreeService orphan reconciliation", () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let branchOrdinal = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-orphans-"),
    );
    repo = path.join(root, "repo");
    stateDir = path.join(root, "state");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function addRegisteredWorktree(
    target: string,
    kind: "committed" | "unborn",
  ): Promise<void> {
    const branch = `orphan-reconcile-${branchOrdinal++}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (kind === "unborn") {
      await git(repo, "worktree", "add", "--orphan", "-b", branch, target);
    } else {
      await git(repo, "worktree", "add", "-b", branch, target, "HEAD");
    }
    await fs.mkdir(path.join(target, "payload"), { recursive: true });
    await fs.writeFile(path.join(target, "payload", "keep.txt"), `${kind}\n`);
  }

  async function expectRegisteredWorktreePreserved(
    target: string,
    kind: "committed" | "unborn",
  ): Promise<void> {
    const result = await service.gc();

    expect(result.orphansDeleted).toBe(0);
    await expect(fs.readFile(path.join(target, "payload", "keep.txt"), "utf8")).resolves.toBe(
      `${kind}\n`,
    );
    const canonicalTarget = await fs.realpath(target);
    const listed = await listGitWorktrees(repo);
    await expect(
      Promise.all(listed.map(async (entry) => await fs.realpath(entry.path))),
    ).resolves.toContain(canonicalTarget);
  }

  it("preserves a committed worktree directly under the worktrees root", async () => {
    const target = path.join(stateDir, "worktrees", "direct-committed");
    await addRegisteredWorktree(target, "committed");

    await expectRegisteredWorktreePreserved(target, "committed");
  });

  it("preserves an unborn worktree directly under the worktrees root", async () => {
    const target = path.join(stateDir, "worktrees", "direct-unborn");
    await addRegisteredWorktree(target, "unborn");

    await expectRegisteredWorktreePreserved(target, "unborn");
  });

  it("preserves a committed worktree under a fingerprint directory", async () => {
    const target = path.join(stateDir, "worktrees", "fingerprint", "nested-committed");
    await addRegisteredWorktree(target, "committed");

    await expectRegisteredWorktreePreserved(target, "committed");
  });

  it("preserves an unborn worktree under a fingerprint directory", async () => {
    const target = path.join(stateDir, "worktrees", "fingerprint", "nested-unborn");
    await addRegisteredWorktree(target, "unborn");

    await expectRegisteredWorktreePreserved(target, "unborn");
  });

  it("deletes unregistered debris under a fingerprint directory", async () => {
    const debris = path.join(stateDir, "worktrees", "fingerprint", "debris");
    await fs.mkdir(debris, { recursive: true });
    await fs.writeFile(path.join(debris, "remove.txt"), "debris\n");

    const result = await service.gc();

    expect(result.orphansDeleted).toBe(1);
    await expect(fs.stat(debris)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defers cleanup when checkout metadata cannot be inspected", async () => {
    const target = path.join(stateDir, "worktrees", "fingerprint", "broken-checkout");
    await fs.mkdir(path.join(target, "payload"), { recursive: true });
    await fs.writeFile(path.join(target, ".git"), "gitdir: /missing/openclaw-worktree-control\n");
    await fs.writeFile(path.join(target, "payload", "keep.txt"), "uncertain\n");

    await expect(service.gc()).rejects.toThrow("git worktree list");
    await expect(fs.readFile(path.join(target, "payload", "keep.txt"), "utf8")).resolves.toBe(
      "uncertain\n",
    );
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes a symlinked state root before matching registered paths",
    async () => {
      const realStateDir = path.join(root, "real-state");
      const linkedStateDir = path.join(root, "linked-state");
      await fs.mkdir(realStateDir);
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      env = { ...process.env, OPENCLAW_STATE_DIR: linkedStateDir };
      service = new ManagedWorktreeService({ env });
      const target = path.join(realStateDir, "worktrees", "fingerprint", "nested-via-symlink");
      await addRegisteredWorktree(target, "committed");

      await expectRegisteredWorktreePreserved(target, "committed");
    },
  );
});
