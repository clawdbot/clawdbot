import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";

type WorkerReclaimStartPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "draining" | "reclaimed" }
>;
export type WorkerReclaimPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "local" | "reclaimed" }
>;

export type WorkerPlacementReclaimBarriers = {
  runReclaimPreparation: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      beforeDrain?: WorkerPlacementAuthorization;
      run: (authorize?: WorkerPlacementAuthorization) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
  runReclaimBarrier: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      beforeDrain?: WorkerPlacementAuthorization;
      begin: () => WorkerReclaimStartPlacement;
      reclaim: (
        localPath: string,
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
