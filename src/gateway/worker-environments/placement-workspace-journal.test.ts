import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-force-abandon.js";
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

  const prune = () =>
    store.pruneOrphanedWorkspaceReconciliations({
      retainFailedOwner: (recoveryError) =>
        recoveryError.startsWith(FORCED_WORKER_ABANDONMENT_ERROR),
    });

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
    expect(store.listWorkspaceReconciliationOwners()).toEqual([]);
  });

  it("retains a failed owner whose forced rollback is retryable", () => {
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

    expect(prune()).toEqual([]);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
  });
});
