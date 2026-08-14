import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { placementTurnOwner, type WorkerPlacementExecutionMode } from "./placement-record.js";
import type {
  createWorkerSessionPlacementStore,
  WorkerSessionPlacementRecord,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { boundedWorkerError } from "./worker-error.js";

export type WorkerDispatchPlacement = WorkerSessionPlacementRecord;
export type WorkerActiveDispatchPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "active" }
>;
export type WorkerFailedDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "failed" }>;
export type WorkerStartingDispatchPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "starting" }
>;
export type WorkerDrainingDispatchPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "draining" }
>;
type WorkerReconcilingDispatchPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "reconciling" }
>;

export type WorkerDispatchPlacementStore = Pick<
  ReturnType<typeof createWorkerSessionPlacementStore>,
  | "adoptActive"
  | "acceptIdleWorkspaceReconciliation"
  | "claimReclaimWorkspaceResult"
  | "claimTurn"
  | "closeWorkerTurnToolState"
  | "fail"
  | "failPendingWorkspaceResult"
  | "forceAbandonPendingWorkspaceResult"
  | "forceAbandonWorkerTurn"
  | "finishReclaim"
  | "get"
  | "loadWorkspaceReconciliation"
  | "beginWorkspaceReconciliation"
  | "abortWorkspaceReconciliation"
  | "canDestroyAcceptedWorkspaceResult"
  | "canDestroyForceAbandonedEnvironment"
  | "isWorkspaceReconciliationRetainedForForcedAbandonment"
  | "retainWorkspaceReconciliationForForcedAbandonment"
  | "listEnvironmentTeardownFences"
  | "listWorkspaceReconciliationOwners"
  | "list"
  | "listPendingWorkspaceResults"
  | "markWorkspaceResultPending"
  | "workspaceResultInstanceId"
  | "validateWorkspaceResultClaim"
  | "recordStagedWorkspaceResult"
  | "recordWorkspaceResultConflict"
  | "acceptWorkspaceResult"
  | "cancelWorkspaceResultAndReleaseTurn"
  | "completeWorkspaceResultAndReleaseTurn"
  | "failWorkspaceResultAndReleaseTurn"
  | "abandonWorkspaceResult"
  | "listForReconcile"
  | "releaseTurn"
  | "startDispatch"
  | "startDrain"
  | "startReconcile"
  | "transition"
  | "updateWorkspaceBaseManifest"
>;

export type WorkerDispatchEnvironmentService = Pick<
  WorkerEnvironmentService,
  | "attachSession"
  | "create"
  | "createFromProfileSnapshot"
  | "destroy"
  | "destroyOwned"
  | "get"
  | "reconcileOnce"
  | "startTunnel"
  | "stopTunnel"
>;

export type WorkerActivationBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementExecutionMode;
  activate: () => WorkerActiveDispatchPlacement;
}) => Promise<WorkerActiveDispatchPlacement>;

const RECOVERY_ERROR_LIMIT = 1_024;
const boundedError = boundedWorkerError;
const RETAINED_WORKSPACE_RESULT_RECOVERY_GUIDANCE =
  "Use Stop cloud worker and confirm abandoning the result to destroy the environment; unreconciled remote workspace changes will be permanently lost";

export function isUnavailableEnvironment(
  environment: NonNullable<ReturnType<WorkerEnvironmentService["get"]>>,
): boolean {
  return (
    environment.state === "draining" ||
    environment.state === "destroying" ||
    environment.state === "destroyed" ||
    environment.state === "failed" ||
    environment.state === "orphaned"
  );
}

export function createPlacementFailureActions(deps: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
}) {
  const { environments, placements } = deps;

  const updateFailure = (
    placement: WorkerDispatchPlacement,
    error: unknown,
  ): WorkerDispatchPlacement =>
    placements.fail({
      sessionId: placement.sessionId,
      expectedGeneration: placement.generation,
      recoveryError: boundedError(error),
    });

  const cleanupEnvironment = async (params: {
    environmentId: string;
    ownerEpoch: number | null;
  }): Promise<string[]> => {
    const teardownErrors: string[] = [];
    try {
      await environments.stopTunnel(params.environmentId, params.ownerEpoch ?? undefined);
    } catch (error) {
      teardownErrors.push(`tunnel stop: ${boundedError(error)}`);
    }
    try {
      await environments.destroy(params.environmentId);
    } catch (error) {
      teardownErrors.push(`environment destroy: ${boundedError(error)}`);
    }
    return teardownErrors;
  };

  const teardownEnvironment = async (params: {
    placement: WorkerDispatchPlacement;
    environmentId: string | null;
    ownerEpoch: number | null;
    primaryError: unknown;
  }): Promise<void> => {
    const environmentId = params.environmentId;
    const teardownErrors = environmentId
      ? await cleanupEnvironment({
          environmentId,
          ownerEpoch: params.ownerEpoch,
        })
      : [];
    const recoveryError = [boundedError(params.primaryError), ...teardownErrors].join("; ");
    updateFailure(
      params.placement,
      new Error(truncateUtf16Safe(recoveryError, RECOVERY_ERROR_LIMIT)),
    );
  };

  const retryFailedTeardown = async (placement: WorkerFailedDispatchPlacement): Promise<void> => {
    if (!placement.environmentId) {
      return;
    }
    const environment = environments.get(placement.environmentId);
    if (
      !environment ||
      environment.state === "destroyed" ||
      environment.state === "failed" ||
      environment.state === "orphaned"
    ) {
      return;
    }
    const teardownErrors = await cleanupEnvironment({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    });
    if (teardownErrors.length > 0) {
      const recoveryError = [placement.recoveryError, ...teardownErrors].filter(Boolean).join("; ");
      placements.fail({
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        recoveryError: truncateUtf16Safe(recoveryError, RECOVERY_ERROR_LIMIT),
      });
    }
  };

  const recordRetainedResultFailure = async (
    placement: WorkerActiveDispatchPlacement | WorkerDrainingDispatchPlacement,
    error: unknown,
  ): Promise<void> => {
    const pending = placements
      .listPendingWorkspaceResults()
      .find(
        (candidate) =>
          candidate.sessionId === placement.sessionId &&
          candidate.environmentId === placement.environmentId &&
          candidate.ownerEpoch === placement.activeOwnerEpoch,
      );
    if (!pending) {
      throw new Error(`Pending cloud workspace result disappeared for ${placement.sessionId}`);
    }
    await placements.failPendingWorkspaceResult({
      pending,
      recoveryError: boundedError(
        new Error(`${boundedError(error)}. ${RETAINED_WORKSPACE_RESULT_RECOVERY_GUIDANCE}.`),
      ),
    });
  };

  const startDrain = (
    placement: WorkerActiveDispatchPlacement,
  ): WorkerDrainingDispatchPlacement => {
    const draining = placements.startDrain({
      sessionId: placement.sessionId,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      expectedGeneration: placement.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("Worker placement drain did not produce a draining placement");
    }
    return draining;
  };

  const startReconcile = (
    placement: WorkerDrainingDispatchPlacement,
  ): WorkerReconcilingDispatchPlacement => {
    const reconciling = placements.startReconcile({
      sessionId: placement.sessionId,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      expectedGeneration: placement.generation,
    });
    if (reconciling.state !== "reconciling") {
      throw new Error("Worker placement reconcile did not produce a reconciling placement");
    }
    return reconciling;
  };

  const finishReconcilingFailure = (
    placement: WorkerReconcilingDispatchPlacement,
    error: unknown,
    teardownErrors: readonly string[],
  ): void => {
    const recoveryError = [boundedError(error), ...teardownErrors].join("; ");
    updateFailure(placement, new Error(truncateUtf16Safe(recoveryError, RECOVERY_ERROR_LIMIT)));
  };

  const failDraining = async (
    placement: WorkerDrainingDispatchPlacement,
    error: unknown,
    options: { forceClaimFence?: boolean } = {},
  ): Promise<void> => {
    if (placement.turnClaim && !options.forceClaimFence) {
      // Draining closes new admission. The admitted turn still owns result
      // reconciliation; startup recovery explicitly fences stale claims.
      return;
    }
    const current = placements.get(placement.sessionId);
    if (current?.state !== "draining") {
      return;
    }
    if (current.turnClaim) {
      await placements.closeWorkerTurnToolState({
        sessionId: current.sessionId,
        claimId: current.turnClaim.claimId,
        runId: current.turnClaim.runId,
        placementGeneration: current.turnClaim.generation,
        owner: placementTurnOwner(current),
      });
    }
    const reconciling = startReconcile(current);
    const teardownErrors = await cleanupEnvironment({
      environmentId: current.environmentId,
      ownerEpoch: current.activeOwnerEpoch,
    });
    finishReconcilingFailure(reconciling, error, teardownErrors);
  };

  const reclaimActive = async (
    placement: WorkerActiveDispatchPlacement,
    environment: ReturnType<WorkerEnvironmentService["get"]>,
    claimedTurnError: Error,
  ): Promise<void> => {
    const draining = startDrain(placement);
    if (draining.turnClaim) {
      await failDraining(draining, claimedTurnError, { forceClaimFence: true });
      return;
    }
    const reconciling = startReconcile(draining);
    if (
      !environment ||
      environment.state === "destroyed" ||
      environment.state === "failed" ||
      environment.state === "orphaned"
    ) {
      finishReconcilingFailure(reconciling, claimedTurnError, []);
      return;
    }
    if (environment && !isUnavailableEnvironment(environment)) {
      const teardownErrors = await cleanupEnvironment({
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      });
      if (teardownErrors.length > 0) {
        finishReconcilingFailure(
          reconciling,
          new Error(`Worker reclaim teardown failed: ${teardownErrors.join("; ")}`),
          [],
        );
        return;
      }
    }
    placements.transition({
      sessionId: reconciling.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
  };

  const failActive = async (
    placement: WorkerActiveDispatchPlacement,
    error: unknown,
    options: { forceClaimFence?: boolean } = {},
  ): Promise<void> => {
    const draining = startDrain(placement);
    await failDraining(draining, error, options);
  };

  return {
    failActive,
    failDraining,
    recordRetainedResultFailure,
    reclaimActive,
    retryFailedTeardown,
    teardownEnvironment,
  };
}

export type PlacementFailureActions = ReturnType<typeof createPlacementFailureActions>;
