import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { getRegistryWorktree } from "./registry.js";
import { acquireWorktreeRunLease, testing as runLeaseTesting } from "./run-lease.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

describe("ManagedWorktreeService removal against a live run lease", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-remove-lease-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    runLeaseTesting.resetForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createSessionWorktree(): Promise<{ id: string; path: string }> {
    const created = await service.create({
      repoRoot: repo,
      name: "removal-session",
      ownerKind: "session",
      ownerId: "agent:main:removal",
    });
    return { id: created.id, path: created.path };
  }

  it("rejects removal before snapshotting while a run lease is live", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });

    await expect(service.remove({ id: created.id, reason: "manual-delete" })).rejects.toThrow(
      "worktree is busy",
    );
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(created.path)).toBeTruthy();

    await lease.release();
    expect((await service.remove({ id: created.id, reason: "manual-delete" })).removed).toBe(true);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a concurrent second remover while the first holds the claim", async () => {
    const created = await createSessionWorktree();
    const first = service.remove({ id: created.id, reason: "manual-delete" });

    await expect(service.remove({ id: created.id, reason: "manual-delete" })).rejects.toThrow(
      /already in progress|unknown active worktree/,
    );

    expect((await first).removed).toBe(true);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips idle garbage collection for a worktree with a live run lease", async () => {
    const created = await createSessionWorktree();
    now += IDLE_GC_MS + 1;
    const lease = await acquireWorktreeRunLease(created.id, { env });

    const skipped = await service.gc();
    expect(skipped.removed).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();

    await lease.release();
    const collected = await service.gc();
    expect(collected.removed).toContain(created.id);
  });
});
