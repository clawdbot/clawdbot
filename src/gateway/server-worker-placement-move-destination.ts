import type { managedWorktrees } from "../agents/worktrees/service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveWorkerPlacementSessionTarget } from "./server-worker-placement-session-target.js";
import type * as sessionUtils from "./session-utils.js";
import { resolveDevicePlacementEligibility } from "./worker-environments/device-placement-eligibility.js";
import { resolveWorkerPlacementDestination } from "./worker-environments/placement-destination.js";
import type * as placementSessionRuntime from "./worker-environments/placement-session-runtime.js";
import type {
  WorkerPlacementMoveDestination,
  WorkerPlacementMoveRequest,
} from "./worker-environments/service-contract.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

type MovePlacementSessionRuntime = {
  managedWorktrees: typeof managedWorktrees;
  resolveWorkerPlacementCapabilities: typeof placementSessionRuntime.resolveWorkerPlacementCapabilities;
  resolveWorkerPlacementSessionRuntime: typeof placementSessionRuntime.resolveWorkerPlacementSessionRuntime;
  resolveCanonicalSessionEntryFromStoreKeys: typeof sessionUtils.resolveCanonicalSessionEntryFromStoreKeys;
  resolveGatewaySessionStoreTargetWithStore: typeof sessionUtils.resolveGatewaySessionStoreTargetWithStore;
};

export function createGatewayWorkerPlacementMoveDestinationResolver(params: {
  environments: WorkerEnvironmentService;
  getConfig: () => OpenClawConfig;
  loadSessionRuntime: () => Promise<MovePlacementSessionRuntime>;
}) {
  return async (
    identity: Pick<WorkerPlacementMoveRequest, "sessionId" | "sessionKey" | "agentId">,
    moveTarget: WorkerPlacementMoveRequest["target"],
  ): Promise<WorkerPlacementMoveDestination | undefined> => {
    if (moveTarget.kind === "gateway") {
      return undefined;
    }
    const sessionRuntime = await params.loadSessionRuntime();
    const { config, target, entry } = resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: params.getConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} changed before placement move recovery.`,
    });
    const destination = resolveWorkerPlacementDestination({
      cfg: config,
      ...(moveTarget.kind === "profile"
        ? { profileId: moveTarget.profileId, machineClass: moveTarget.machineClass }
        : { deviceId: moveTarget.deviceId }),
    });
    if (!destination.ok || !destination.value) {
      throw new Error(destination.ok ? "worker move target is missing" : destination.error);
    }
    const runtime = sessionRuntime.resolveWorkerPlacementSessionRuntime({
      cfg: config,
      entry,
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
    });
    const { executionMode, devicePlacement } =
      sessionRuntime.resolveWorkerPlacementCapabilities(runtime);
    if (!executionMode) {
      throw new Error(`Runtime ${runtime} lacks cloud placement support`);
    }
    if (moveTarget.kind === "profile") {
      if (!params.environments.supportsExecutionMode(moveTarget.profileId, executionMode)) {
        throw new Error(
          `worker profile ${moveTarget.profileId} does not support ${executionMode} placement; select a compatible worker provider`,
        );
      }
    } else {
      const eligibility = await resolveDevicePlacementEligibility({
        environmentService: params.environments,
        deviceId: moveTarget.deviceId,
        runtimeId: runtime,
        requirement: devicePlacement,
        config,
      });
      if (!eligibility.ok) {
        throw new Error(eligibility.error);
      }
    }
    return { executionMode, ...destination.value, ...(devicePlacement ? { devicePlacement } : {}) };
  };
}
