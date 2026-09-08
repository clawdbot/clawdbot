import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ensureRepositoryWorkspacePendingResultSchema,
  hasRepositoryWorkspacePendingResultSchema,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "./session-repository-workspaces.js";

const roots: string[] = [];
const assertCurrent = () => {};
const source = {
  agentId: "main",
  sessionKey: "agent:main:repository",
  url: "https://github.com/example/project.git",
  requestedRef: "main",
  assertCurrent,
};
const baseCommit = "a".repeat(40);
const baseManifestHash = `sha256:${"b".repeat(64)}`;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    closeOpenClawStateDatabaseByPath(path.join(root, "openclaw.sqlite"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repository-owner-"));
  roots.push(root);
  const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
  return { database, store: createSessionRepositoryWorkspaceStore({ database }) };
}

it("retries rolled-back first-use pending owner DDL and preserves the committed column on reopen", async () => {
  const { database } = await fixture();
  database.db.exec(
    "ALTER TABLE worker_workspace_pending_results DROP COLUMN repository_workspace_id",
  );
  expect(hasRepositoryWorkspacePendingResultSchema(database.db)).toBe(false);
  expect(() =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        ensureRepositoryWorkspacePendingResultSchema(db);
        expect(hasRepositoryWorkspacePendingResultSchema(db)).toBe(true);
        throw new Error("pending result rolled back");
      },
      { database },
    ),
  ).toThrow("pending result rolled back");
  expect(hasRepositoryWorkspacePendingResultSchema(database.db)).toBe(false);
  runOpenClawStateWriteTransaction(({ db }) => ensureRepositoryWorkspacePendingResultSchema(db), {
    database,
  });
  expect(hasRepositoryWorkspacePendingResultSchema(database.db)).toBe(true);
  closeOpenClawStateDatabaseByPath(database.path);
  expect(
    hasRepositoryWorkspacePendingResultSchema(
      openOpenClawStateDatabase({ path: database.path }).db,
    ),
  ).toBe(true);
});

it("creates one stable logical-session owner without widening replayed setup intent", async () => {
  const { database, store } = await fixture();
  expect(store.find(source)).toBeUndefined();
  expect(tableExists(database.db, "session_repository_workspaces")).toBe(false);
  expect(() =>
    runOpenClawStateWriteTransaction(
      () => {
        store.create(source);
        throw new Error("session creation rolled back");
      },
      { database },
    ),
  ).toThrow("session creation rolled back");
  expect(tableExists(database.db, "session_repository_workspaces")).toBe(false);
  const initial = store.create(source);
  expect(store.create({ ...source, runSetupScript: true })).toEqual(initial);
  expect(initial.runSetupScript).toBe(false);
  expect(initial.branch).toBe(`openclaw/${initial.workspaceId}`);
  expect(() => store.create({ ...source, requestedRef: "other" })).toThrow("different repository");
  expect(store.create({ ...source, agentId: "other" }).workspaceId).not.toBe(initial.workspaceId);
});

it("pins the source base and rejects stale or closed checkpoint mutations", async () => {
  const { store } = await fixture();
  const initial = store.create(source);
  const bound = store.bindBase({
    workspaceId: initial.workspaceId,
    expectedRevision: initial.revision,
    baseCommit,
    baseManifestHash,
    assertCurrent,
  });
  const checkpoint = {
    workspaceId: bound.workspaceId,
    expectedRevision: bound.revision,
    checkpointRef: "refs/openclaw/worker-results/turn-1",
    manifestHash: `sha256:${"c".repeat(64)}`,
    assertCurrent,
  };
  expect(() =>
    store.acceptCheckpoint({
      ...checkpoint,
      assertCurrent: () => {
        throw new Error("claim closed");
      },
    }),
  ).toThrow("claim closed");
  expect(store.get(bound.workspaceId)).toEqual(bound);
  expect(() =>
    store.bindBase({
      workspaceId: bound.workspaceId,
      expectedRevision: bound.revision,
      baseCommit: "d".repeat(40),
      assertCurrent,
    }),
  ).toThrow("base changed");
  const accepted = store.acceptCheckpoint(checkpoint);
  expect(() => store.acceptCheckpoint(checkpoint)).toThrow("revision changed");
  expect(accepted).toMatchObject({
    baseCommit,
    baseManifestHash,
    checkpointRef: checkpoint.checkpointRef,
    manifestHash: checkpoint.manifestHash,
    revision: bound.revision + 1,
  });
});

it("reopens the accepted owner and deletes only its own artifacts", async () => {
  const { database, store } = await fixture();
  const initial = store.create(source);
  const sibling = store.create({ ...source, sessionKey: "agent:main:sibling" });
  await fs.mkdir(store.artifactPath(initial.workspaceId), { recursive: true });
  await fs.mkdir(store.artifactPath(sibling.workspaceId), { recursive: true });
  closeOpenClawStateDatabaseByPath(database.path);
  const reopened = createSessionRepositoryWorkspaceStore({
    database: openOpenClawStateDatabase({ path: database.path }),
  });
  expect(reopened.find(source)).toEqual(initial);
  await reopened.delete({ workspaceId: initial.workspaceId, assertCurrent });
  expect(reopened.find(source)).toBeUndefined();
  await expect(fs.stat(reopened.artifactPath(initial.workspaceId))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(reopened.get(sibling.workspaceId)).toEqual(sibling);
  expect((await fs.stat(reopened.artifactPath(sibling.workspaceId))).isDirectory()).toBe(true);
});
