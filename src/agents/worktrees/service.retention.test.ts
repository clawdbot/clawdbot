import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";

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
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
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
      service.setRetentionClaimByPath(
        created.path,
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
      restarted.setRetentionClaimByPath(
        created.path,
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
      restarted.setRetentionClaimByPath(
        created.path,
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
});
