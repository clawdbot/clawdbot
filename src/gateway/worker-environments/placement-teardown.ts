import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";

type ReconcilingPlacement = Extract<WorkerSessionPlacementRecord, { state: "reconciling" }>;
type PlacementTeardownStore = Pick<
  WorkerSessionPlacementStore,
  | "completePlacementMoveSourceToLocal"
  | "completeWorkspaceResultAndReleaseTurn"
  | "startReconcile"
  | "transition"
>;

/** Close the workspace-result fence, then advance the exact drained owner into reconciliation. */
export function completeDrainedWorkspaceTeardown(params: {
  placements: PlacementTeardownStore;
  turnClaim: WorkerSessionTurnClaim;
  environmentId: string;
  ownerEpoch: number;
  complete: (placement: ReconcilingPlacement) => WorkerSessionPlacementRecord;
}): WorkerSessionPlacementRecord {
  const drained = params.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim);
  if (
    drained.state !== "draining" ||
    drained.environmentId !== params.environmentId ||
    drained.activeOwnerEpoch !== params.ownerEpoch
  ) {
    throw new Error(`Session ${params.turnClaim.sessionId} lost its drained placement owner`);
  }
  const reconciling = params.placements.startReconcile({
    sessionId: drained.sessionId,
    environmentId: params.environmentId,
    ownerEpoch: params.ownerEpoch,
    expectedGeneration: drained.generation,
  });
  if (reconciling.state !== "reconciling") {
    throw new Error(`Session ${params.turnClaim.sessionId} did not enter reconciliation`);
  }
  return params.complete(reconciling);
}

export function completeMovedWorkspaceTeardown(params: {
  placements: PlacementTeardownStore;
  turnClaim: WorkerSessionTurnClaim;
  environmentId: string;
  ownerEpoch: number;
  operationId: string;
}): Extract<WorkerSessionPlacementRecord, { state: "local" }> {
  const completed = completeDrainedWorkspaceTeardown({
    ...params,
    complete: (reconciling) =>
      params.placements.completePlacementMoveSourceToLocal({
        operationId: params.operationId,
        sessionId: reconciling.sessionId,
        expectedGeneration: reconciling.generation,
      }),
  });
  if (completed.state !== "local") {
    throw new Error(`Session ${params.turnClaim.sessionId} move did not finish local`);
  }
  return completed;
}

export function completeReclaimedWorkspaceTeardown(params: {
  placements: PlacementTeardownStore;
  turnClaim: WorkerSessionTurnClaim;
  environmentId: string;
  ownerEpoch: number;
}): Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }> {
  const completed = completeDrainedWorkspaceTeardown({
    ...params,
    complete: (reconciling) =>
      params.placements.transition({
        sessionId: reconciling.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      }),
  });
  if (completed.state !== "reclaimed") {
    throw new Error(`Session ${params.turnClaim.sessionId} teardown did not finish reclaimed`);
  }
  return completed;
}
