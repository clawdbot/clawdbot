import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

type WorkerReclaimStartPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "draining" | "reclaimed" }
>;
export type WorkerReclaimPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "local" | "reclaimed" }
>;

export type WorkerPlacementCancellationTarget = Readonly<
  Pick<WorkerSessionPlacementRecord, "state" | "generation" | "environmentId" | "activeOwnerEpoch">
>;

export function matchesWorkerPlacementTarget(
  current: WorkerPlacementCancellationTarget | undefined,
  expected: WorkerPlacementCancellationTarget | undefined,
): boolean {
  return (
    current?.state === expected?.state &&
    current?.generation === expected?.generation &&
    current?.environmentId === expected?.environmentId &&
    current?.activeOwnerEpoch === expected?.activeOwnerEpoch
  );
}

export type WorkerPlacementPendingOperations = {
  isCurrent: () => boolean;
  hasPendingDispatch: () => boolean;
  currentPlacement: () => WorkerPlacementCancellationTarget | undefined;
  completedPlacement: () => WorkerPlacementCancellationTarget | undefined;
  settled: Promise<unknown>;
};

export type WorkerPlacementReclaimBarriers = {
  runReclaimPreparation: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      beforeDrain?: WorkerPlacementAuthorization;
      pendingOperations?: WorkerPlacementPendingOperations;
      run: (authorize?: WorkerPlacementAuthorization) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
  runReclaimBarrier: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      beforeDrain?: WorkerPlacementAuthorization;
      begin: () => WorkerReclaimStartPlacement;
      reclaim: (
        workspace: WorkerSessionWorkspace,
        placement: WorkerReclaimStartPlacement,
        authorize?: WorkerPlacementAuthorization,
      ) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
  runFailedReclaimBarrier: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      reclaim: (authorize?: WorkerPlacementAuthorization) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
};
