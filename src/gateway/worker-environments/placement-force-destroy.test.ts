import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("forced worker environment destruction", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-force-destroy-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("serializes with workspace work and abandons an applied result fence", async () => {
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const harness = createHarness(placementStore, { workspaceOperations, workspacePath: root });
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    const active = harness.placements.seedActive(harness.attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "force-destroy-claim",
      runId: "force-destroy-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const appliedManifestRef = harness.reconciledManifestRef;
    placementStore.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "a".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: appliedManifestRef,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    placementStore.updateWorkspaceBaseManifest({ claim, manifestRef: appliedManifestRef });
    expect(placementStore.loadWorkspaceReconciliation(owner)?.appliedManifestRef).toBe(
      appliedManifestRef,
    );

    const releaseWorkspaceOperation = createDeferred();
    const workspaceOperation = workspaceOperations.run(active.environmentId, async () => {
      await releaseWorkspaceOperation.promise;
    });
    const forceDestroy = harness.service.forceDestroyEnvironment(active.environmentId);
    await Promise.resolve();
    expect(harness.environments.destroy).not.toHaveBeenCalled();

    releaseWorkspaceOperation.resolve();
    await expect(Promise.all([workspaceOperation, forceDestroy])).resolves.toEqual([
      undefined,
      expect.objectContaining({ state: "destroyed" }),
    ]);
    expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Cloud worker result abandoned by forced operator teardown",
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(placementStore.listWorkspaceReconciliationOwners()).toEqual([]);
  });

  it.each([
    { failure: "tunnel stop", state: "draining" as const },
    { failure: "provider stop", state: "destroying" as const },
  ])("stays successful after $failure failure", async ({ state }) => {
    const harness = createHarness(placementStore, {
      destroyFails: true,
      destroyFailureState: state,
      workspacePath: root,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    const onCleanupError = vi.fn();

    await expect(
      harness.service.forceDestroyEnvironment(harness.ready.environmentId, onCleanupError),
    ).resolves.toMatchObject({ state });

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Cloud worker result abandoned by forced operator teardown",
    });
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "destroy pending" }),
    );
  });

  it("retries remote teardown when a failed rollback journal remains", async () => {
    const harness = createHarness(placementStore, {
      destroyFails: true,
      destroyFailureState: "destroying",
      failAt: "workspace",
    });
    const active = harness.placements.seedActive(harness.attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    placementStore.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "e".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"e".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });

    await expect(
      harness.service.forceDestroyEnvironment(active.environmentId),
    ).resolves.toMatchObject({ state: "destroying" });
    expect(placementStore.listWorkspaceReconciliationOwners()).toEqual([owner]);
    vi.mocked(harness.environments.destroy).mockClear();

    await harness.service.reconcileActive(active.environmentId);

    expect(harness.environments.destroy).toHaveBeenCalledExactlyOnceWith(active.environmentId);
  });
});
