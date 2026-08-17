import { describe, expect, it } from "vitest";
import { admitWorkerConnection } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";

describe("worker environment node provisioning", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("commits an installed Gateway bundle receipt and credential for a node lease", async () => {
    const workerBuild = structuredClone(support.BOOTSTRAP_RECEIPT);
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const placementGate = createWorkerSessionPlacementGate(placements);
    const workerService = support.createService(
      support.createProvider({
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-1",
          node: { deviceId: "device-1" },
          sharedHost: true,
        }),
      }),
      { ensureNodeWorkerBundle: async () => workerBuild, placementStore: placementGate },
    );

    const result = await workerService.create("development", "request-device");

    expect(result).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      sshEndpoint: null,
      bootstrapReceipt: { ...workerBuild, installKind: "bundle" },
      sharedHost: true,
      ownerEpoch: 1,
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    const credential = workerService.takeMintedCredential({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: null,
    });
    expect(credential).toMatchObject({
      credential: support.CREDENTIAL,
      bundleHash: support.BUNDLE_HASH,
    });
    const attachedCredential = await workerService.attachSession({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    await support.waitForFast(() => {
      expect({
        environment: support.testState.store.get(result.environmentId),
        credential: support.testState.store.getCredential(result.environmentId),
      }).toMatchObject({
        environment: {
          state: "attached",
          ownerEpoch: attachedCredential.ownerEpoch,
          attachedSessionIds: [REQUEST.sessionId],
        },
        credential: {
          credentialHash: hashWorkerCredential(attachedCredential.credential),
          bundleHash: workerBuild.bundleHash,
          sessionId: REQUEST.sessionId,
          ownerEpoch: attachedCredential.ownerEpoch,
        },
      });
    });
    seedActivePlacement(placements, {
      environmentId: result.environmentId,
      ownerEpoch: attachedCredential.ownerEpoch,
    });
    const turnClaim = placements.claimTurn({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      claimId: "claim-device",
      runId: "run-device",
      owner: {
        kind: "worker",
        environmentId: result.environmentId,
        ownerEpoch: attachedCredential.ownerEpoch,
      },
    });
    const turnCredential = await workerService.acquireTurnCredential(turnClaim);
    const admission = {
      environmentId: result.environmentId,
      credential: turnCredential.credential,
      ownerEpoch: attachedCredential.ownerEpoch,
      rpcSetVersion: 1,
      sessionId: REQUEST.sessionId,
      runId: turnClaim.runId,
      handshake: workerBuild,
    } as const;
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission,
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
        turnClaim,
      }),
    ).toMatchObject({ ok: true });
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission: {
          ...admission,
          handshake: { ...workerBuild, bundleHash: "d".repeat(64) },
        },
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
        turnClaim,
      }),
    ).toEqual({ ok: false, reason: "bundle-mismatch" });
  });
});
