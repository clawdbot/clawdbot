import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

function seedAttached(environmentId: string) {
  support.seedBootstrapping(environmentId);
  support.testState.store.transition({
    environmentId,
    from: "bootstrapping",
    to: "ready",
    patch: support.readyPatch(environmentId, {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    }),
  });
  return support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: support.attachedPatch(environmentId, REQUEST.sessionId),
  });
}

function createDispatch(
  environments: WorkerEnvironmentService,
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
) {
  return coordinateWorkerPlacementDispatch(
    createWorkerPlacementDispatchService({
      placements,
      environments,
      runnerAvailability: { read: () => undefined, version: () => 0 },
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      runLocalBarrier: async ({ startDispatch }) => startDispatch(),
      runRecoveryBarrier: async ({ run }) =>
        await run({ kind: "local", path: support.testState.root }),
      runActivationBarrier: async ({ activate }) => activate(),
      runMoveBarrier: async ({ begin }) => begin(),
      resolveMoveDestination: async () => undefined,
      runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
      runReclaimBarrier: async ({ begin, reclaim }) =>
        await reclaim({ kind: "local", path: support.testState.root }, begin()),
      runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
      resolveWorkspace: async () => ({ kind: "local", path: support.testState.root }),
      reportWorkspaceResultConflict: async () => {},
      resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
    }),
    (_request, run) => run(),
  );
}

describe("targeted worker placement recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(() => {
    support.testState.prepareInstallation = async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    });
  });

  it("does not wait for a sibling provider inspection; full sweeps still inspect and maintain it", async () => {
    const targetId = "worker-target";
    const siblingId = "worker-sibling";
    const identity = seedAttached(targetId);
    support.seedReady(siblingId);
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    seedActivePlacement(placements, {
      environmentId: targetId,
      ownerEpoch: identity.ownerEpoch,
      executionMode: "remote-exec",
    });
    const inspectionStarted = createDeferredCore();
    const releaseInspection = createDeferredCore();
    const inspected: string[] = [];
    const maintainProviders = vi.fn(async () => {});
    const environments = support.createService(
      support.createProvider({
        inspect: async ({ leaseId }) => {
          inspected.push(leaseId);
          if (leaseId === `lease:${siblingId}`) {
            inspectionStarted.resolve();
            await releaseInspection.promise;
          }
          return { status: "active" };
        },
      }),
      { maintainProviders },
    );
    const dispatch = createDispatch(environments, placements);
    const uninstall = installWorkerPlacementReconcileGuard({
      placements,
      environments,
      dispatch,
      isStopping: () => false,
    });
    const targeted = dispatch.reconcileActive(targetId);
    let first;
    let inspectedBeforeRelease: string[];
    try {
      first = await Promise.race([
        targeted.then(() => "target-finished"),
        inspectionStarted.promise.then(() => "sibling-inspection"),
      ]);
      inspectedBeforeRelease = [...inspected];
    } finally {
      releaseInspection.resolve();
      await targeted;
      await uninstall();
    }
    inspected.length = 0;
    maintainProviders.mockClear();
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    await dispatch.reconcileActive();
    expect(inspected.toSorted()).toEqual([`lease:${siblingId}`, `lease:${targetId}`]);
    expect(maintainProviders).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledOnce();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
    expect(first).toBe("target-finished");
    expect(inspectedBeforeRelease).toEqual([`lease:${targetId}`]);
  });

  it("leaves an unrelated move for the full sweep instead of waiting for its workspace cleanup", async () => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const harness = createHarness(placements, {
      workspacePath: support.testState.root,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      afterReconcile: async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      },
    });
    const active = await harness.service.dispatch(REQUEST);
    seedAttached(active.environmentId);
    placements.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    const dispatch = coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run());
    const targeted = dispatch.reconcileActive("worker-unrelated");
    let first;
    let retainedAfterTarget;
    try {
      first = await Promise.race([
        targeted.then(() => "target-finished"),
        cleanupStarted.promise.then(() => "unrelated-move-cleanup"),
      ]);
      retainedAfterTarget = placements.getPlacementMove(active.sessionId);
    } finally {
      releaseCleanup.resolve();
      await targeted;
    }
    await dispatch.reconcileActive();
    expect(placements.get(active.sessionId)?.state).toBe("local");
    expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(harness.log.filter((event) => event === "workspace:reconcile")).toHaveLength(1);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(first).toBe("target-finished");
    expect(retainedAfterTarget).toBeDefined();
  });

  it.each(["source", "destination"] as const)(
    "recovers a move selected by its %s after source cleanup already completed",
    async (match) => {
      const sourceId = "worker-move-source";
      const destinationId = "worker-move-destination";
      const sourceIdentity = seedAttached(sourceId);
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const active = seedActivePlacement(placements, {
        environmentId: sourceId,
        ownerEpoch: sourceIdentity.ownerEpoch,
        executionMode: "remote-exec",
      });
      const begun = placements.beginPlacementMove({
        sessionId: active.sessionId,
        source: {
          generation: active.generation,
          environmentId: sourceId,
          ownerEpoch: sourceIdentity.ownerEpoch,
        },
        target: { kind: "profile", profileId: "development" },
      });
      const reconciling = placements.startReconcile({
        sessionId: active.sessionId,
        environmentId: sourceId,
        ownerEpoch: sourceIdentity.ownerEpoch,
        expectedGeneration: begun.placement.generation,
      });
      placements.completePlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: active.sessionId,
        expectedGeneration: reconciling.generation,
      });
      const environments = support.createService(support.createProvider());
      await environments.destroy(sourceId);
      if (match === "destination") {
        const destination = seedAttached(destinationId);
        seedActivePlacement(placements, {
          environmentId: destinationId,
          ownerEpoch: destination.ownerEpoch,
          executionMode: "remote-exec",
        });
      }
      const dispatch = createDispatch(environments, placements);
      await dispatch.reconcileActive(match === "source" ? sourceId : destinationId);
      expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
      expect(placements.get(active.sessionId)?.state).toBe(
        match === "source" ? "failed" : "active",
      );
      if (match === "source") {
        expect(placements.get(active.sessionId)?.recoveryError).toContain("authority expired");
      }
    },
  );
});
