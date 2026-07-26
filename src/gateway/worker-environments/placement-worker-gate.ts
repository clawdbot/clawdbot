import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerPlacementTurnBinding, WorkerSessionPlacementGate } from "./service.js";

function claimForBinding(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementTurnBinding,
): WorkerSessionTurnClaim | undefined {
  const persisted = record?.turnClaim;
  if (
    !record ||
    (record.state !== "active" && record.state !== "draining") ||
    record.environmentId !== binding.environmentId ||
    record.activeOwnerEpoch !== binding.ownerEpoch ||
    persisted?.owner !== "worker" ||
    persisted.runId !== binding.runId ||
    persisted.ownerEpoch !== binding.ownerEpoch
  ) {
    return undefined;
  }
  return {
    sessionId: binding.sessionId,
    claimId: persisted.claimId,
    runId: persisted.runId,
    placementGeneration: persisted.generation,
    owner: {
      kind: "worker",
      environmentId: binding.environmentId,
      ownerEpoch: binding.ownerEpoch,
    },
  };
}

export function createWorkerSessionPlacementGate(
  store: WorkerSessionPlacementStore,
): WorkerSessionPlacementGate {
  const validateWorkerTurn = (binding: WorkerPlacementTurnBinding): boolean => {
    const claim = claimForBinding(store.get(binding.sessionId), binding);
    return claim ? store.validateTurnClaim(claim) : false;
  };

  return {
    validateWorkerTurn,

    updateAckCursors(binding): void {
      const claim = claimForBinding(store.get(binding.sessionId), binding);
      if (!claim) {
        throw new Error(`Cannot ACK stale worker turn for session ${binding.sessionId}`);
      }
      store.updateAckCursors({
        claim,
        ...(binding.transcriptSeq === undefined ? {} : { transcript: binding.transcriptSeq }),
        ...(binding.liveSeq === undefined ? {} : { liveEvent: binding.liveSeq }),
        ...(binding.workspaceResultPending === undefined
          ? {}
          : { workspaceResultPending: binding.workspaceResultPending }),
      });
    },
  };
}
