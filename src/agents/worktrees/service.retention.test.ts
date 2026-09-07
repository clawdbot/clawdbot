import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

describe("managed worktree retention claims", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = tempDirs.make("worktree-retention-", await fs.realpath(os.tmpdir()));
    // Disk admission is covered separately; these tiny fixtures exercise retention owners.
    const disk = fsSync.statfsSync(root);
    disk.bavail = 100_000_000;
    disk.bfree = 100_000_000;
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(disk);
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["clone", "--bare", repo, remote]);
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-u", "origin", "main");
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it("persists across run-end, idle, count, and size cleanup", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "retained-artifact",
      ownerKind: "workboard",
      ownerId: "card-retained",
    });
    expect(
      service.setRetentionClaim(
        created.id,
        { ownerKind: "workboard", ownerId: "card-retained" },
        { claimId: "artifact", active: true },
      ),
    ).toBe(true);

    const restarted = new ManagedWorktreeService({ env, now: () => now });
    expect(await restarted.removeIfLossless(created.id)).toBe(false);
    now += IDLE_GC_MS + 1;
    expect((await restarted.gc()).removed).toEqual([]);
    expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);

    await fs.writeFile(path.join(created.path, "artifact.bin"), Buffer.alloc(10_000));
    expect((await restarted.gc({ limits: { maxTotalSizeBytes: 1 } })).removed).toEqual([]);
    await expect(fs.stat(created.path)).resolves.toBeDefined();

    expect(
      restarted.setRetentionClaim(
        created.id,
        { ownerKind: "workboard", ownerId: "card-retained" },
        { claimId: "artifact", active: false },
      ),
    ).toBe(true);
    expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([created.id]);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lazily adds retention claims to a pre-existing current-schema database", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "legacy-retained-artifact",
      ownerKind: "workboard",
      ownerId: "card-legacy-retained",
    });
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    expect(legacy.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    legacy.exec("DROP TABLE worktree_retention_claims;");
    legacy.close();

    const reopened = openOpenClawStateDatabase({ env });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worktree_retention_claims"),
    ).toBeUndefined();

    const restarted = new ManagedWorktreeService({ env, now: () => now });
    expect(
      restarted.setRetentionClaim(
        created.id,
        { ownerKind: "workboard", ownerId: "card-legacy-retained" },
        { claimId: "artifact", active: true },
      ),
    ).toBe(true);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worktree_retention_claims"),
    ).toEqual({ name: "worktree_retention_claims" });
    expect(await restarted.removeIfLossless(created.id)).toBe(false);
  });

  it.each([false, true])(
    "keeps cancellation terminal across restart when acquired first is %s",
    async (acquiredFirst) => {
      const owner = { ownerKind: "workboard", ownerId: "card-cancelled" } as const;
      const created = await service.create({ repoRoot: repo, name: "cancelled", ...owner });
      if (acquiredFirst) {
        expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: true })).toBe(
          true,
        );
      }
      expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: false })).toBe(
        true,
      );
      closeOpenClawStateDatabaseForTest();
      const restarted = new ManagedWorktreeService({ env, now: () => now });
      expect(restarted.setRetentionClaim(created.id, owner, { claimId: "old", active: true })).toBe(
        false,
      );
      expect(restarted.setRetentionClaim(created.id, owner, { claimId: "new", active: true })).toBe(
        true,
      );
      expect(
        restarted.setRetentionClaim(created.id, owner, { claimId: "old", active: false }),
      ).toBe(true);
      expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);
      expect(
        restarted.setRetentionClaim(created.id, owner, { claimId: "new", active: false }),
      ).toBe(true);
      expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([created.id]);
    },
  );

  it("resolves only the exact owner and keeps other owners from changing claims", async () => {
    const owner = { ownerKind: "workboard", ownerId: "card-owned" } as const;
    const created = await service.create({ repoRoot: repo, name: "owned", ...owner });
    expect(service.resolveRetentionTargetByPath(created.path, owner)).toBe(created.id);
    for (const other of [
      { ownerKind: "workboard", ownerId: "another-card" },
      { ownerKind: "session", ownerId: owner.ownerId },
    ] as const) {
      expect(service.resolveRetentionTargetByPath(created.path, other)).toBeUndefined();
      for (const active of [true, false]) {
        expect(service.setRetentionClaim(created.id, other, { claimId: "owned", active })).toBe(
          false,
        );
      }
    }
    expect(service.setRetentionClaim(created.id, owner, { claimId: "owned", active: true })).toBe(
      true,
    );
    expect(await service.removeIfLossless(created.id)).toBe(false);
  });

  it("keeps released generations through restore and prunes them only with registry identity", async () => {
    const owner = { ownerKind: "workboard", ownerId: "card-restored" } as const;
    const created = await service.create({ repoRoot: repo, name: "restored", ...owner });
    expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: true })).toBe(
      true,
    );
    expect(
      (await service.remove({ id: created.id, reason: "test-explicit-removal" })).removed,
    ).toBe(true);
    expect(service.resolveRetentionTargetByPath(created.path, owner)).toBeUndefined();
    expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: false })).toBe(
      true,
    );
    await service.restore({ id: created.id });
    expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: true })).toBe(
      false,
    );
    expect(await service.removeIfLossless(created.id)).toBe(true);
    now += SNAPSHOT_RETENTION_MS + 1;
    const database = openOpenClawStateDatabase({ env }).db;
    database.exec(`
      CREATE TRIGGER retain_registry_identity BEFORE DELETE ON worktrees
      BEGIN SELECT RAISE(ABORT, 'injected registry prune failure'); END;
    `);
    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(
      database
        .prepare("SELECT claim_id FROM worktree_retention_claims WHERE worktree_id = ?")
        .all(created.id),
    ).toEqual([{ claim_id: "old" }]);
    database.exec("DROP TRIGGER retain_registry_identity");
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(
      database
        .prepare("SELECT claim_id FROM worktree_retention_claims WHERE worktree_id = ?")
        .all(created.id),
    ).toEqual([]);
    const replacement = await service.create({ repoRoot: repo, name: "restored", ...owner });
    expect(replacement.id).not.toBe(created.id);
    expect(replacement.path).toBe(created.path);
    expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: false })).toBe(
      true,
    );
    expect(service.setRetentionClaim(created.id, owner, { claimId: "old", active: true })).toBe(
      false,
    );
    expect(await service.removeIfLossless(replacement.id)).toBe(true);
  });

  it("rejects acquisition during removal but can terminally cancel that generation", async () => {
    const owner = { ownerKind: "workboard", ownerId: "card-removing" } as const;
    const created = await service.create({ repoRoot: repo, name: "removing", ...owner });
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" });
    try {
      expect(() =>
        service.setRetentionClaim(created.id, owner, { claimId: "delayed", active: true }),
      ).toThrow("worktree removal is already in progress");
      expect(
        service.setRetentionClaim(created.id, owner, { claimId: "delayed", active: false }),
      ).toBe(true);
    } finally {
      abortWorktreeRemoval(env, created.id, "remover");
    }
    expect(service.setRetentionClaim(created.id, owner, { claimId: "delayed", active: true })).toBe(
      false,
    );
    expect(await service.removeIfLossless(created.id)).toBe(true);
  });
});
