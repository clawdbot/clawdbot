import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentService } from "./service.js";

type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

export function createReclaimedPlacementRedispatch(params: {
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatch: WorkerPlacementDispatchService["dispatch"];
}) {
  return async (placement: ReclaimedWorkerPlacement) => {
    const previousEnvironment = params.environments.get(placement.environmentId);
    if (!previousEnvironment) {
      throw new Error(
        `Reclaimed worker placement has no environment record: ${placement.environmentId}`,
      );
    }
    return await params.dispatch({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      profileId: previousEnvironment.profileId,
    });
  };
}
