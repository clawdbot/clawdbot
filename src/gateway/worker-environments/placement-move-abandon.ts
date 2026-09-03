import {
  isUnavailableEnvironment,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  forceAbandonWorkerEnvironment,
  reportWorkerAbandonmentCleanupError,
} from "./placement-force-abandon.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  isForceAbandonedWorkerPlacement,
} from "./placement-record.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

export function createWorkerPlacementMoveAbandonment(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspacePath: (placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>;
}) {
  const { environments, placements } = options;
  const forceDestroyEnvironment = async (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) =>
    await options.workspaceOperations.run(environmentId, async () => {
      await forceAbandonWorkerEnvironment({
        placements,
        environmentId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        onCleanupError,
      });
      try {
        return await environments.destroy(environmentId, "operator-abandon");
      } catch (error) {
        const current = environments.get(environmentId);
        if (!current || !isUnavailableEnvironment(current)) {
          throw error;
        }
        reportWorkerAbandonmentCleanupError(onCleanupError, error);
        return current;
      }
    });

  const validateAbandonSource = (request: WorkerPlacementMoveRequest): void => {
    const current = placements.get(request.sessionId);
    if (
      (current?.state !== "active" && !isForceAbandonedWorkerPlacement(current)) ||
      current.generation !== request.source.generation ||
      current.environmentId !== request.source.environmentId ||
      current.activeOwnerEpoch !== request.source.ownerEpoch
    ) {
      throw new Error(`Cannot abandon stale worker placement for session ${request.sessionKey}`);
    }
    if (isForceAbandonedWorkerPlacement(current)) {
      return;
    }
    const runner = options.runnerAvailability.read(current);
    if (!runner) {
      throw new Error(
        "Continue on Gateway can abandon only an active paired-device placement with a known runner binding",
      );
    }
    if (runner.status === "available") {
      throw new Error(
        "Device runner is available; use Move session so OpenClaw can reconcile its workspace safely",
      );
    }
  };

  const abandonSource = async (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<Extract<WorkerDispatchPlacement, { state: "local" }>> => {
    const current = placements.get(request.sessionId);
    if (
      !current ||
      (current.state !== "active" &&
        current.state !== "draining" &&
        current.state !== "reconciling" &&
        current.state !== "failed") ||
      current.environmentId !== intent.source.environmentId ||
      current.activeOwnerEpoch !== intent.source.ownerEpoch
    ) {
      throw new Error(`Session ${request.sessionKey} abandonment source changed before teardown`);
    }
    await forceDestroyEnvironment(intent.source.environmentId);
    authorize?.();
    const failed = placements.get(request.sessionId);
    if (failed?.state !== "failed") {
      throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
    }
    if (
      !isFailedWorkerPlacementEnvironmentGone({
        environmentService: environments,
        placement: failed,
      })
    ) {
      throw new Error(
        `Session ${request.sessionKey} device teardown is still pending; retry Continue on Gateway`,
      );
    }
    const local = placements.completeAbandonedPlacementMoveSourceToLocal({
      operationId: intent.operationId,
      sessionId: intent.sessionId,
      expectedGeneration: failed.generation,
      expectedRecoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    if (local.state !== "local") {
      throw new Error(`Session ${request.sessionKey} abandonment did not finish on the Gateway`);
    }
    return local;
  };

  return { abandonSource, forceDestroyEnvironment, validateAbandonSource };
}
