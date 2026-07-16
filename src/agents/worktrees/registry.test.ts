import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  deleteRegistryWorktree,
  getRegistryWorktreeProvisionedChunk,
  findRegistryWorktreeByPath,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedLedger,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktreeProvisionedChunk,
  insertRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
} from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

describe("managed worktree registry", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-registry-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists, orders, updates, and deletes worktree rows through Kysely", () => {
    const record: ManagedWorktreeRecord = {
      id: "first",
      name: "task",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(root, "repo"),
      path: path.join(root, "worktrees", "task"),
      branch: "openclaw/task",
      baseRef: "HEAD",
      ownerKind: "workboard",
      ownerId: "card-1",
      createdAt: 10,
      lastActiveAt: 10,
    };
    insertRegistryWorktree(env, record, { provisionedPaths: [".env.local"] });
    insertRegistryWorktree(env, {
      ...record,
      id: "second",
      name: "task-2",
      path: path.join(root, "worktrees", "task-2"),
      createdAt: 20,
      lastActiveAt: 20,
    });

    expect(listRegistryWorktrees(env).map((entry) => entry.id)).toEqual(["second", "first"]);
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toMatchObject({
      id: "first",
      ownerKind: "workboard",
      ownerId: "card-1",
    });
    expect(getRegistryWorktreeProvisionedPaths(env, "first")).toEqual([".env.local"]);
    expect(getRegistryWorktreeProvisionedPaths(env, "second")).toBeUndefined();
    expect(getRegistryWorktreeProvisionedLedger(env, "second")).toEqual({ status: "legacy" });

    updateRegistryWorktree(env, "first", {
      lastActiveAt: 30,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/first",
      provisionedState: [{ path: ".env.local", mode: 0o600, chunks: 1 }],
    });
    expect(getRegistryWorktree(env, "first")).toMatchObject({
      lastActiveAt: 30,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/first",
    });
    expect(findLiveRegistryWorktreeByPath(env, record.path)).toBeUndefined();
    expect(findRegistryWorktreeByPath(env, record.path)?.id).toBe("first");
    expect(getRegistryWorktreeProvisionedPaths(env, "first")).toEqual([".env.local"]);
    expect(getRegistryWorktreeProvisionedState(env, "first")).toEqual([
      { path: ".env.local", mode: 0o600, chunks: 1 },
    ]);
    expect(getRegistryWorktreeProvisionedLedger(env, "first")).toEqual({
      status: "valid",
      paths: [".env.local"],
    });
    insertRegistryWorktreeProvisionedChunk(env, {
      worktreeId: "first",
      path: ".env.local",
      chunkIndex: 0,
      data: Buffer.from("snapshot"),
    });
    expect(
      Buffer.from(
        getRegistryWorktreeProvisionedChunk(env, {
          worktreeId: "first",
          path: ".env.local",
          chunkIndex: 0,
        })!,
      ).toString(),
    ).toBe("snapshot");

    deleteRegistryWorktree(env, "first");
    expect(getRegistryWorktree(env, "first")).toBeUndefined();
    expect(
      getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: "first",
        path: ".env.local",
        chunkIndex: 0,
      }),
    ).toBeUndefined();

    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET provisioned_paths_json = ? WHERE id = ?")
      .run("not-json", "second");
    expect(getRegistryWorktreeProvisionedLedger(env, "second")).toEqual({ status: "invalid" });
  });

  it("adds the provisioned-path ledger to an existing worktree registry", () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE worktrees DROP COLUMN provisioned_paths_json");
    legacy.close();

    expect(getRegistryWorktreeProvisionedPaths(env, "missing")).toBeUndefined();
    const database = openOpenClawStateDatabase({ env }).db;
    const columns = database.prepare("PRAGMA table_info(worktrees)").all() as Array<{
      name?: unknown;
    }>;
    expect(columns.some((column) => column.name === "provisioned_paths_json")).toBe(true);
    const chunkTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worktree_provisioned_file_chunks'",
      )
      .get();
    expect(chunkTable).toBeTruthy();
  });
});
