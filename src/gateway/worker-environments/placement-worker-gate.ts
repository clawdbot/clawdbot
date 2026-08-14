import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";

type WorkerPlacementBinding = Readonly<{
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
}>;

export type WorkerPlacementTurnBinding = WorkerPlacementBinding &
  Readonly<{
    runId: string;
  }>;

export type WorkerSessionPlacementGate = {
  hasWorkerTurn(binding: WorkerPlacementBinding): boolean;
  isEnvironmentTeardownFenced(environmentId: string): boolean;
  validateWorkerTurn(binding: WorkerPlacementTurnBinding): boolean;
  isWorkerTurnToolAuthorized(binding: WorkerPlacementTurnBinding, toolName: string): boolean;
  updateAckCursors(
    binding: WorkerPlacementTurnBinding & {
      transcriptSeq?: number;
      liveSeq?: number;
    },
  ): void;
};

function claimForBinding(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementBinding & { runId?: string },
): WorkerSessionTurnClaim | undefined {
  const persisted = record?.turnClaim;
  if (
    !record ||
    (record.state !== "active" && record.state !== "draining") ||
    record.environmentId !== binding.environmentId ||
    record.activeOwnerEpoch !== binding.ownerEpoch ||
    persisted?.owner !== "worker" ||
    (binding.runId !== undefined && persisted.runId !== binding.runId) ||
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
    hasWorkerTurn(binding): boolean {
      const claim = claimForBinding(store.get(binding.sessionId), binding);
      return claim ? store.validateTurnClaim(claim) : false;
    },
    isEnvironmentTeardownFenced: (environmentId) =>
      store.isEnvironmentTeardownFenced(environmentId),

    validateWorkerTurn,

    isWorkerTurnToolAuthorized(binding, toolName): boolean {
      return store.isWorkerTurnToolAuthorized(binding, toolName);
    },

    updateAckCursors(binding): void {
      const claim = claimForBinding(store.get(binding.sessionId), binding);
      if (!claim) {
        throw new Error(`Cannot ACK stale worker turn for session ${binding.sessionId}`);
      }
      store.updateAckCursors({
        claim,
        ...(binding.transcriptSeq === undefined ? {} : { transcript: binding.transcriptSeq }),
        ...(binding.liveSeq === undefined ? {} : { liveEvent: binding.liveSeq }),
      });
    },
  };
}
