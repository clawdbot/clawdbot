import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  getRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import { acquireWorktreeRunLease, claimWorktreeRemoval } from "./run-lease.js";
import { testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import {
  useManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("ManagedWorktreeService run-end cleanup outcomes", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  const now = 1_700_000_000_000;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-run-end-cleanup-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    runLeaseTesting.resetForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function materialize(name: string) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now,
      ownerKind: "workboard",
      ownerId: `card-${name}`,
      repoRoot: repo,
      stateDir,
    });
  }

  it("removes an allocated worktree when its commit guard closes during setup", async () => {
    const setup = path.join(repo, ".openclaw");
    await fs.mkdir(setup);
    const closed = path.join(setup, "authority-closed");
    await fs.writeFile(
      path.join(setup, "worktree-setup.sh"),
      '#!/bin/sh\ntouch "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/authority-closed"\n',
      { mode: 0o755 },
    );
    await expect(
      service.create({
        repoRoot: repo,
        name: "closed-authority",
        baseRef: "HEAD",
        commitGuard: () => {
          if (existsSync(closed)) {
            throw new TypeError("authority closed");
          }
        },
      }),
    ).rejects.toThrow("authority closed");

    expect(existsSync(closed)).toBe(true);

    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("closed-authority");
    expect(await git(repo, "branch", "--list", "openclaw/closed-authority")).toBe("");
    expect(listRegistryWorktrees(env)).toEqual([]);
  });

  it("records removal after clean run-end cleanup", async () => {
    const created = await materialize("clean");
    await service.acquire(created.id);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      removedAt: now,
      runEndCleanup: { outcome: "removed-lossless", at: now },
    });
    await expect(fs.access(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the winning removal outcome when a stale remover claims late", async () => {
    const created = await materialize("late-claim");
    await service.acquire(created.id);
    const staleRecord = getRegistryWorktree(env, created.id)!;

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

    let contention: unknown;
    try {
      claimWorktreeRemoval(env, {
        worktreeId: staleRecord.id,
        token: "late-remover",
      });
    } catch (error) {
      contention = error;
    }
    expect(contention).toBeInstanceOf(WorktreeRemovalContentionError);
    expect(contention).toMatchObject({ kind: "finalized" });
    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      removedAt: now,
      runEndCleanup: { outcome: "removed-lossless", at: now },
    });
  });

  it("keeps the winning removal outcome when a post-abort write lands after finalization", async () => {
    const created = await materialize("post-abort-race");
    await service.acquire(created.id);
    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

    // A stale remover that aborted its claim writes retained/failed outcomes with
    // the live-row condition (recordOutcome); against a finalized row it must be
    // a no-op instead of replacing the winner's removed-lossless fact.
    updateRegistryWorktree(
      env,
      created.id,
      { runEndCleanup: { outcome: "retained-dirty", at: now + 1 } },
      { onlyIfLive: true },
    );

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      removedAt: now,
      runEndCleanup: { outcome: "removed-lossless", at: now },
    });
  });

  it("lets a newer post-restore cleanup outcome supersede the removal fact", async () => {
    const created = await materialize("restore-generation");
    await service.acquire(created.id);
    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup).toMatchObject({
      outcome: "removed-lossless",
    });

    const restored = await service.restore({ id: created.id });
    // Restore starts a new lifecycle: the stale removal outcome must not show
    // on the now-live row.
    expect(restored.runEndCleanup).toBeUndefined();
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup).toBeUndefined();
    await fs.writeFile(path.join(restored.path, "untracked.txt"), "retain me\n");
    await service.acquire(created.id);
    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      runEndCleanup: { outcome: "retained-dirty", at: now },
    });
  });

  it("drops a prior-lifecycle outcome write after a concurrent remove and restore", async () => {
    const created = await materialize("aba-restore-race");
    const staleActiveAt = created.lastActiveAt;
    await service.acquire(created.id);
    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);
    // The pinned clock makes remove and restore share one millisecond — the
    // exact case where restore must still advance the activity stamp so the
    // stale writer's fence cannot match.
    const restored = await service.restore({ id: created.id });
    expect(restored.lastActiveAt).toBe(staleActiveAt + 1);

    // A stale remover from the pre-restore lifecycle writes with the activity
    // stamp it observed (recordOutcome's condition); against the revived row it
    // must be a no-op instead of stamping a prior-lifecycle outcome.
    updateRegistryWorktree(
      env,
      created.id,
      { runEndCleanup: { outcome: "retained-dirty", at: now + 1 } },
      { onlyIfLive: true, onlyIfActiveAt: staleActiveAt },
    );

    expect(getRegistryWorktree(env, created.id)?.runEndCleanup).toBeUndefined();
  });

  it("records dirty retention and keeps the checkout intact", async () => {
    const created = await materialize("dirty");
    await service.acquire(created.id);
    const dirtyFile = path.join(created.path, "untracked.txt");
    await fs.writeFile(dirtyFile, "retain me\n");

    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

    const retained = getRegistryWorktree(env, created.id);
    expect(retained).toMatchObject({
      runEndCleanup: { outcome: "retained-dirty", at: now },
    });
    expect(retained?.removedAt).toBeUndefined();
    await expect(fs.readFile(dirtyFile, "utf8")).resolves.toBe("retain me\n");
  });

  it.each([
    { kind: "independent", linked: false },
    { kind: "same-repository linked", linked: true },
  ])("retains an ignored nested $kind repository at run end", async ({ linked }) => {
    await fs.writeFile(path.join(repo, ".gitignore"), "nested/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore nested checkout state");
    await git(repo, "push", "origin", "main");

    const created = await materialize(linked ? "nested-linked" : "nested-independent");
    const nested = path.join(created.path, "nested", "checkout");
    await fs.mkdir(linked ? path.dirname(nested) : nested, { recursive: true });
    if (linked) {
      await git(repo, "worktree", "add", "--detach", nested, "HEAD");
    } else {
      await git(nested, "init", "-b", "main");
    }
    const localState = path.join(nested, "local.txt");
    await fs.writeFile(localState, "keep nested checkout state\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await git(created.path, "log", "HEAD", "--not", "--remotes", "--oneline")).toBe("");
    await service.acquire(created.id);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      runEndCleanup: { outcome: "retained-dirty", at: now },
    });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(localState, "utf8")).toBe("keep nested checkout state\n");
    if (linked) {
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(nested);
    } else {
      expect((await fs.stat(path.join(nested, ".git"))).isDirectory()).toBe(true);
    }
  });

  it("records unpushed retention", async () => {
    const created = await materialize("unpushed");
    await service.acquire(created.id);
    await fs.writeFile(path.join(created.path, "committed.txt"), "unpushed\n");
    await git(created.path, "add", "committed.txt");
    await git(created.path, "commit", "-m", "unpushed worktree commit");

    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

    const retained = getRegistryWorktree(env, created.id);
    expect(retained).toMatchObject({
      runEndCleanup: { outcome: "retained-unpushed", at: now },
    });
    expect(retained?.removedAt).toBeUndefined();
    await expect(fs.access(created.path)).resolves.toBeUndefined();
  });

  it("records busy retention while a run lease is live", async () => {
    const created = await materialize("busy");
    const lease = await acquireWorktreeRunLease(created.id, { env });

    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

    const retained = getRegistryWorktree(env, created.id);
    expect(retained).toMatchObject({
      runEndCleanup: { outcome: "retained-busy", at: now },
    });
    expect(retained?.removedAt).toBeUndefined();
    await expect(fs.access(created.path)).resolves.toBeUndefined();
    await lease.release();
  });

  it("records and rethrows an unexpected removal claim failure", async () => {
    const created = await materialize("claim-failure");
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const failure = new Error("synthetic removal claim failure");
    runLeaseTesting.setDeadPidResolverForTest(() => {
      throw failure;
    });

    await expect(service.removeIfLossless(created.id)).rejects.toBe(failure);

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      runEndCleanup: {
        outcome: "failed",
        at: now,
        reason: "synthetic removal claim failure",
      },
    });
    await expect(fs.access(created.path)).resolves.toBeUndefined();
    runLeaseTesting.setDeadPidResolverForTest(null);
    await lease.release();
  });
});
