import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { lockState, unlockWorktree } from "./git-lock.js";
import {
  admitWorktreeRunLeaseRow,
  getRegistryWorktree,
  releaseWorktreeRunLeaseRow,
} from "./registry.js";
import {
  testing as runLeaseTesting,
  abortWorktreeRemoval,
  acquireWorktreeRunLease,
  claimWorktreeRemoval,
  hasLiveWorktreeRunLease,
  resolveWorktreeIdForPath,
} from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";

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

describe("worktree run lease", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-run-lease-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    service = new ManagedWorktreeService({ env });
  });

  afterEach(async () => {
    runLeaseTesting.resetForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createSessionWorktree(): Promise<{ id: string; path: string }> {
    const created = await service.create({
      repoRoot: repo,
      name: "run-lease-session",
      ownerKind: "session",
      ownerId: "agent:main:run-lease",
    });
    return { id: created.id, path: created.path };
  }

  it("shares one worktree across concurrent runs and refcounts the git lock", async () => {
    const created = await createSessionWorktree();
    const parent = await acquireWorktreeRunLease(created.id, { env });
    const child = await acquireWorktreeRunLease(created.id, { env });

    const record = getRegistryWorktree(env, created.id);
    expect(record).toBeDefined();
    expect(await lockState(record!)).toEqual({ kind: "live", pid: process.pid });
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);

    await parent.release();
    expect(await lockState(record!)).toEqual({ kind: "live", pid: process.pid });
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);

    await child.release();
    expect(await lockState(record!)).toEqual({ kind: "none" });
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
  });

  it("resolves the worktree id for a nested workspace path with no session binding", async () => {
    const created = await createSessionWorktree();
    const nested = path.join(created.path, "workspace");
    await fs.mkdir(nested);

    const resolved = await resolveWorktreeIdForPath({ candidatePaths: [nested], env });
    expect(resolved).toBe(created.id);

    const lease = await acquireWorktreeRunLease(created.id, { env });
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: false }),
    ).toThrow("worktree is busy");
    await lease.release();
  });

  it("prunes a dead owner lease so removal can proceed", async () => {
    const created = await createSessionWorktree();
    admitWorktreeRunLeaseRow(env, {
      worktreeId: created.id,
      token: "dead-owner",
      pid: 987_654,
      startTime: 4242,
      now: 1,
    });
    runLeaseTesting.setDeadPidResolverForTest((pid) => pid === 987_654);

    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: false }),
    ).not.toThrow();
  });

  it("prunes a reused pid whose start time no longer matches", async () => {
    const created = await createSessionWorktree();
    admitWorktreeRunLeaseRow(env, {
      worktreeId: created.id,
      token: "reused-pid",
      pid: process.pid,
      startTime: 111,
      now: 1,
    });
    runLeaseTesting.setProcessStartTimeResolverForTest(() => 222);

    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);

    const lease = await acquireWorktreeRunLease(created.id, { env });
    expect(lease.token).not.toBe("reused-pid");
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
    await lease.release();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
  });

  it("rejects removal of a live lease unless forced", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });

    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: false }),
    ).toThrow("worktree is busy");
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: true }),
    ).not.toThrow();
    await lease.release();
  });

  it("fails admission once a removal claim is held", async () => {
    const created = await createSessionWorktree();
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: true });

    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      `managed worktree was removed: ${created.path}`,
    );
  });

  it("recovers admission when the remover died before finalizing the removal", async () => {
    const created = await createSessionWorktree();
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: true });
    runLeaseTesting.setDeadPidResolverForTest((pid) => pid === process.pid);

    const lease = await acquireWorktreeRunLease(created.id, { env });
    expect(lease.token).toBeTruthy();
    await lease.release();
  });

  it("rejects a second live remover until the first releases, even with force", async () => {
    const created = await createSessionWorktree();
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-a", force: false });

    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b", force: false }),
    ).toThrow("worktree removal is already in progress");
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b", force: true }),
    ).toThrow("worktree removal is already in progress");

    abortWorktreeRemoval(env, created.id, "remover-a");
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b", force: false }),
    ).not.toThrow();
  });

  it("recovers a transient release failure within a single release call", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let attempts = 0;
    runLeaseTesting.setReleaseRowImplForTest((rowEnv, id, token) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("simulated state database failure");
      }
      releaseWorktreeRunLeaseRow(rowEnv, id, token);
    });

    await lease.release();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("retains the lease and git guard across sustained delete failures, freeing on a lifecycle retry", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let fail = true;
    runLeaseTesting.setReleaseRowImplForTest((rowEnv, id, token) => {
      if (fail) {
        throw new Error("simulated state database failure");
      }
      releaseWorktreeRunLeaseRow(rowEnv, id, token);
    });

    await lease.release();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: false }),
    ).toThrow("worktree is busy");

    fail = false;
    await runLeaseTesting.drainPendingCleanupsForTest();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(await lockState(record)).toEqual({ kind: "none" });
    expect(() =>
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover", force: false }),
    ).not.toThrow();
  });

  it("serializes overlapping same-process acquisitions so the guard holds until the last release", async () => {
    const created = await createSessionWorktree();
    const record = getRegistryWorktree(env, created.id)!;

    const [first, second] = await Promise.all([
      acquireWorktreeRunLease(created.id, { env }),
      acquireWorktreeRunLease(created.id, { env }),
    ]);

    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    await first.release();
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    await second.release();
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("retains the git guard when unlock fails, releasing it on a lifecycle retry", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let failUnlock = true;
    runLeaseTesting.setUnlockImplForTest(async (rec) => {
      if (failUnlock) {
        throw new Error("simulated git unlock failure");
      }
      await unlockWorktree(rec);
    });

    await lease.release();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });

    failUnlock = false;
    await runLeaseTesting.drainPendingCleanupsForTest();
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("does not let a failed cleanup unlock a newer holder generation", async () => {
    const created = await createSessionWorktree();
    const first = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let failUnlock = true;
    runLeaseTesting.setUnlockImplForTest(async (rec) => {
      if (failUnlock) {
        throw new Error("simulated git unlock failure");
      }
      await unlockWorktree(rec);
    });

    await first.release();
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });

    const second = await acquireWorktreeRunLease(created.id, { env });
    failUnlock = false;
    await runLeaseTesting.drainPendingCleanupsForTest();
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });

    await second.release();
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("fails closed when a session's authoritative worktree binding is removed", async () => {
    const created = await createSessionWorktree();
    await service.remove({ id: created.id, reason: "manual-delete", force: true });

    await expect(
      resolveWorktreeIdForPath({
        sessionEntry: { worktree: { id: created.id } },
        candidatePaths: [],
        env,
      }),
    ).rejects.toThrow("managed worktree was removed");
  });

  it("does not let a superseded remover clear a newer removal claim", async () => {
    const created = await createSessionWorktree();
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-a", force: false });

    runLeaseTesting.setDeadPidResolverForTest((pid) => pid === process.pid);
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b", force: false });
    runLeaseTesting.setDeadPidResolverForTest(null);

    abortWorktreeRemoval(env, created.id, "remover-a");
    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      "managed worktree was removed",
    );
  });
});
