import {
  projectWorkerSessionTurnClaim,
  serializeWorkerSessionTurnClaim,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  getWorkerTurnExecutionIdentityCapability,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";

type WorkerPlacementBinding = Readonly<{
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
}>;

export type WorkerSessionPlacementGate = {
  /** Credential verification only; this does not grant operational worker authority. */
  readWorkerTurnClaim(binding: WorkerPlacementBinding): WorkerSessionTurnClaim | undefined;
  getExecutionIdentityCapability?(
    claim: WorkerSessionTurnClaim,
  ): WorkerTurnExecutionIdentityCapability | undefined;
  validateWorkerTurn(claim: WorkerSessionTurnClaim): boolean;
  isWorkerTurnToolAuthorized(claim: WorkerSessionTurnClaim, toolName: string): boolean;
  updateAckCursors(input: {
    claim: WorkerSessionTurnClaim;
    transcriptSeq?: number;
    liveSeq?: number;
  }): void;
  registerTurnClaimClosedHandler(handler: (claim: WorkerSessionTurnClaim) => void): () => void;
};

function claimForBinding(
  record: WorkerSessionPlacementRecord | undefined,
  binding: WorkerPlacementBinding,
): WorkerSessionTurnClaim | undefined {
  const claim = record ? projectWorkerSessionTurnClaim(record) : undefined;
  return claim?.sessionId === binding.sessionId &&
    claim.owner.environmentId === binding.environmentId &&
    claim.owner.ownerEpoch === binding.ownerEpoch
    ? claim
    : undefined;
}

export function createWorkerSessionPlacementGate(
  store: WorkerSessionPlacementStore,
  options: { rejectExistingWorkerClaims?: boolean } = {},
): WorkerSessionPlacementGate {
  const recoveryOnlyClaims = new Set(
    options.rejectExistingWorkerClaims
      ? store.list().flatMap((record) => {
          const claim = projectWorkerSessionTurnClaim(record);
          return claim ? [serializeWorkerSessionTurnClaim(claim)] : [];
        })
      : [],
  );
  const isOperational = (claim: WorkerSessionTurnClaim) =>
    !recoveryOnlyClaims.has(serializeWorkerSessionTurnClaim(claim)) &&
    store.validateTurnClaim(claim);

  const readWorkerTurnClaim = (binding: WorkerPlacementBinding) => {
    const claim = claimForBinding(store.get(binding.sessionId), binding);
    return claim && store.validateTurnClaim(claim) ? claim : undefined;
  };

  const validateWorkerTurn = (claim: WorkerSessionTurnClaim) => isOperational(claim);

  return {
    readWorkerTurnClaim,
    getExecutionIdentityCapability: (claim) =>
      getWorkerTurnExecutionIdentityCapability(store, claim),
    validateWorkerTurn,

    isWorkerTurnToolAuthorized(claim, toolName): boolean {
      return validateWorkerTurn(claim) && store.isWorkerTurnToolAuthorized(claim, toolName);
    },

    updateAckCursors(input): void {
      if (!validateWorkerTurn(input.claim)) {
        throw new Error(`Cannot ACK stale worker turn for session ${input.claim.sessionId}`);
      }
      store.updateAckCursors({
        claim: input.claim,
        ...(input.transcriptSeq === undefined ? {} : { transcript: input.transcriptSeq }),
        ...(input.liveSeq === undefined ? {} : { liveEvent: input.liveSeq }),
      });
    },

    registerTurnClaimClosedHandler: (handler) => store.registerTurnClaimClosedHandler(handler),
  };
}
