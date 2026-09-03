import { describe, expect, it, vi } from "vitest";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

const ENVIRONMENT_ID = "worker-stale-result-owner";
const SESSION_ID = "session-stale-result-owner";

describe("worker environment owner revocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("hands off a pending worker result before stale-build owner revocation", async () => {
    const ready = support.seedReady(ENVIRONMENT_ID);
    const attached = support.testState.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: ready.state,
      to: "attached",
      patch: support.attachedPatch(ENVIRONMENT_ID, SESSION_ID),
    });
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    let placement = placements.startDispatch({
      sessionId: SESSION_ID,
      sessionKey: "agent:main:stale-result-owner",
      agentId: "main",
      executionMode: "worker-turn",
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: ENVIRONMENT_ID },
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "b".repeat(64) },
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        remoteWorkspaceDir: "/worker/stale-result-owner",
        workspaceBaseManifestRef: `sha256:${"c".repeat(64)}`,
      },
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: attached.ownerEpoch },
    });
    const claim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      claimId: "claim-stale-result-owner",
      runId: "run-stale-result-owner",
      owner: {
        kind: "worker",
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: attached.ownerEpoch,
      },
    });
    const placementStore = createWorkerSessionPlacementGate(placements);
    placementStore.updateAckCursors({ claim, liveSeq: 1 });
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {
        expect(placements.listPendingWorkspaceResults()).toMatchObject([
          { sessionId: SESSION_ID, recoveryRequestedAtMs: expect.any(Number) },
        ]);
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    support.testState.stateDb.db
      .prepare(
        "UPDATE worker_environments SET bootstrap_bundle_hash = ?, bootstrap_install_kind = 'local' WHERE environment_id = ?",
      )
      .run("b".repeat(64), ENVIRONMENT_ID);

    await support
      .createService(support.createProvider({ destroy: vi.fn(async () => {}) }), {
        placementStore,
        tunnelManager,
      })
      .reconcileOnce();

    expect(tunnelManager.stop).toHaveBeenCalledOnce();
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: SESSION_ID, recoveryRequestedAtMs: expect.any(Number) },
    ]);
  });
});
