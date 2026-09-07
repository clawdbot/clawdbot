import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
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
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

export function createWorkerPlacementMoveAbandonment(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspace: (placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<WorkerSessionWorkspace>;
  prepareGatewayMove?: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    assertCurrent: () => void;
  }) => Promise<void>;
}) {
  const { environments, placements } = options;
  const forceDestroyEnvironment = async (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) =>
    await options.workspaceOperations.run(environmentId, async () => {
      // Capture the selected owner before journal cleanup can yield to a replacement.
      const environment = environments.get(environmentId);
      const sessionId = environment?.attachedSessionIds[0];
      const abandonment =
        environment?.providerId === DEVICE_WORKER_PROVIDER_ID &&
        environment.nodeDeviceId &&
        environment.sharedHost !== false &&
        environment.attachedSessionIds.length === 1 &&
        sessionId
          ? { sessionId, ownerEpoch: environment.ownerEpoch }
          : undefined;
      await forceAbandonWorkerEnvironment({
        placements,
        environmentId,
        resolveWorkspace: options.resolveWorkspace,
        onCleanupError,
      });
      try {
        return await (abandonment
          ? environments.destroy(environmentId, abandonment)
          : environments.destroy(environmentId));
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
    await options.workspaceOperations.run(intent.source.environmentId, async () => {
      await forceAbandonWorkerEnvironment({
        placements,
        environmentId: intent.source.environmentId,
        resolveWorkspace: options.resolveWorkspace,
      });
      const failed = placements.get(request.sessionId);
      if (!isForceAbandonedWorkerPlacement(failed)) {
        throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
      }
      const assertCurrent = () => {
        authorize?.();
        const latest = placements.get(request.sessionId);
        if (
          !isForceAbandonedWorkerPlacement(latest) ||
          latest.generation !== failed.generation ||
          latest.environmentId !== intent.source.environmentId ||
          latest.activeOwnerEpoch !== intent.source.ownerEpoch ||
          placements.getPlacementMove(request.sessionId)?.operationId !== intent.operationId
        ) {
          throw new Error(
            `Session ${request.sessionKey} abandonment source changed during Gateway preparation`,
          );
        }
      };
      assertCurrent();
      if (intent.target.kind === "gateway") {
        if (options.prepareGatewayMove) {
          await options.prepareGatewayMove({ ...request, assertCurrent });
        } else if ((await options.resolveWorkspace(failed)).kind === "repository") {
          throw new Error("Repository workspace Gateway materialization is unavailable");
        }
        assertCurrent();
      }
      if (environments.get(intent.source.environmentId)) {
        await environments.destroy(intent.source.environmentId, {
          sessionId: intent.sessionId,
          ownerEpoch: intent.source.ownerEpoch,
          authorize: assertCurrent,
        });
      }
    });
    authorize?.();
    const failed = placements.get(request.sessionId);
    if (failed?.state !== "failed") {
      throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
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
