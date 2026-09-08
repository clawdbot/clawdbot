import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

export function claimWorkerPlacement(params: {
  environmentId: string;
  ownerEpoch: number;
  runId?: string;
  sessionId: string;
}): { claim: WorkerSessionTurnClaim; store: ReturnType<typeof createWorkerSessionPlacementStore> } {
  const store = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const identity = {
    sessionId: params.sessionId,
    agentId: "main",
    sessionKey: `agent:main:${params.sessionId}`,
  };
  let placement = store.startDispatch(identity);
  placement = store.transition({
    sessionId: params.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: params.environmentId },
  });
  placement = store.transition({
    sessionId: params.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: support.BUNDLE_HASH },
  });
  placement = store.transition({
    sessionId: params.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `manifest-${params.sessionId}`,
      remoteWorkspaceDir: `/workspace/${params.sessionId}`,
    },
  });
  store.transition({
    sessionId: params.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: params.ownerEpoch },
  });
  const claim = store.claimTurn({
    ...identity,
    claimId: `claim-${params.sessionId}`,
    runId: params.runId ?? "run-1",
    owner: {
      kind: "worker",
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
    },
  });
  return { claim, store };
}
