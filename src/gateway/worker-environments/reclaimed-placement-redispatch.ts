import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerDevicePlacementRequirementResolver } from "./placement-dispatch-startup.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentService } from "./service.js";

type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

export function createReclaimedPlacementRedispatch(params: {
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatch: WorkerPlacementDispatchService["dispatch"];
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
}) {
  return async (placement: ReclaimedWorkerPlacement) => {
    const previousEnvironment = params.environments.get(placement.environmentId);
    if (!previousEnvironment) {
      throw new Error(
        `Reclaimed worker placement has no environment record: ${placement.environmentId}`,
      );
    }
    let devicePlacement: Awaited<ReturnType<WorkerDevicePlacementRequirementResolver>> | undefined;
    if (
      previousEnvironment.providerId === DEVICE_WORKER_PROVIDER_ID &&
      previousEnvironment.nodeDeviceId
    ) {
      if (!params.resolveDevicePlacementRequirement) {
        throw new Error("Paired-device redispatch has no authoritative runtime requirement");
      }
      devicePlacement = await params.resolveDevicePlacementRequirement({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        executionMode: placement.executionMode,
      });
    }
    return await params.dispatch({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      profileId: previousEnvironment.profileId,
      executionMode: placement.executionMode,
      ...(previousEnvironment.providerId === DEVICE_WORKER_PROVIDER_ID &&
      previousEnvironment.nodeDeviceId
        ? { deviceId: previousEnvironment.nodeDeviceId, devicePlacement }
        : {}),
      inheritedProfile: {
        providerId: previousEnvironment.providerId,
        profileSnapshot: previousEnvironment.profileSnapshot,
      },
    });
  };
}
