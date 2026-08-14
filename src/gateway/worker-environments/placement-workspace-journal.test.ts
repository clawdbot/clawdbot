import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement workspace journal", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(() => {
    root = tempDirs.make("openclaw-journal-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  const prune = () => store.pruneOrphanedWorkspaceReconciliations();

  const seedJournal = () => {
    const active = seedActivePlacement(store, { environmentId: "worker-1", ownerEpoch: 7 });
    if (active.state !== "active") {
      throw new Error("expected active placement");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const basePack = Buffer.from("orphaned workspace base pack");
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "c".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"d".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "e".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    return { active, owner };
  };

  it("prunes a workspace journal only after its exact owner is gone", () => {
    const { active, owner } = seedJournal();

    expect(store.isEnvironmentTeardownFenced(active.environmentId)).toBe(true);
    expect(prune()).toEqual([]);
    const draining = store.startDrain({
      sessionId: REQUEST.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining placement");
    }
    store.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });

    expect(prune()).toEqual([owner]);
    expect(store.isEnvironmentTeardownFenced(active.environmentId)).toBe(false);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([]);
  });

  it("retains a failed owner whose forced rollback is retryable", () => {
    const { active, owner } = seedJournal();
    expect(store.isWorkspaceReconciliationRetainedForForcedAbandonment(owner)).toBe(false);
    store.retainWorkspaceReconciliationForForcedAbandonment(owner);
    expect(store.isWorkspaceReconciliationRetainedForForcedAbandonment(owner)).toBe(true);
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining placement");
    }
    const reconciling = store.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    store.fail({
      sessionId: reconciling.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });

    expect(store.isWorkspaceReconciliationRetainedForPendingResult(owner)).toBe(false);
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ path: databasePath });
    store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    expect(store.isWorkspaceReconciliationRetainedForForcedAbandonment(owner)).toBe(true);
    expect(prune()).toEqual([]);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
  });

  it("retains a migrated v6 forced-abandonment journal during startup pruning", () => {
    const { active, owner } = seedJournal();
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining placement");
    }
    const reconciling = store.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    store.fail({
      sessionId: reconciling.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });

    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE worker_workspace_reconciliations
        DROP COLUMN forced_abandonment_retained;
      PRAGMA user_version = 6;
      UPDATE schema_meta SET schema_version = 6 WHERE meta_key = 'primary';
    `);
    legacy.close();

    database = openOpenClawStateDatabase({ path: databasePath });
    store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    expect(prune()).toEqual([]);
    expect(store.isWorkspaceReconciliationRetainedForForcedAbandonment(owner)).toBe(true);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
  });

  it("retains a terminal failed owner with its matching pending result", async () => {
    const { active, owner } = seedJournal();
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "terminal-result-claim",
      runId: "terminal-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    store.markWorkspaceResultPending(claim);
    await store.failPendingWorkspaceResult({
      pending: store.listPendingWorkspaceResults()[0]!,
      recoveryError:
        "workspace quiescence recovery timed out; lease retained for operator recovery",
    });

    expect(store.isWorkspaceReconciliationRetainedForPendingResult(owner)).toBe(true);
    expect(prune()).toEqual([]);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
  });

  it("retains a draining journal owned by a terminal pending result after restart", async () => {
    const active = seedActivePlacement(store, { environmentId: "worker-1", ownerEpoch: 7 });
    if (active.state !== "active") {
      throw new Error("expected active placement");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "draining-result-claim",
      runId: "draining-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining placement");
    }
    const owner = {
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      placementGeneration: draining.generation,
    };
    const basePack = Buffer.from("draining workspace base pack");
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "a".repeat(32),
      baseManifestRef: draining.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"b".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "c".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    store.markWorkspaceResultPending(claim);
    await store.failPendingWorkspaceResult({
      pending: store.listPendingWorkspaceResults()[0]!,
      recoveryError: "terminal recovery retained for operator action",
    });

    expect(store.isWorkspaceReconciliationRetainedForPendingResult(owner)).toBe(true);
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ path: databasePath });
    store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    expect(store.isWorkspaceReconciliationRetainedForPendingResult(owner)).toBe(true);
    expect(prune()).toEqual([]);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
  });

  it("prunes an ordinary failed owner without a pending result", () => {
    const { active, owner } = seedJournal();
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining placement");
    }
    const reconciling = store.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    store.fail({
      sessionId: reconciling.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: "ordinary placement failure",
    });

    expect(prune()).toEqual([owner]);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([]);
  });
});
