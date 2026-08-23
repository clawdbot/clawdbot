import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { supportsWorkerExecutionContextLaunch } from "./admission.js";
import { placementTurnOwner, type WorkerPlacementExecutionMode } from "./placement-record.js";
import type {
  createWorkerSessionPlacementStore,
  WorkerSessionPlacementRecord,
} from "./placement-store.js";
import type { WorkerPlacementAuthorization } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import { boundedWorkerError } from "./worker-error.js";

export type WorkerDispatchPlacement = WorkerSessionPlacementRecord;
export type WorkerActiveDispatchPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "active" }
>;
export type WorkerFailedDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "failed" }>;
export type WorkerProvisioningDispatchPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "provisioning" }
>;
type WorkerDrainingDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "draining" }>;
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
  | "beginPlacementMove"
  | "preparePlacementMove"
  | "cancelPlacementMove"
  | "completePlacementMoveSourceToLocal"
  | "completeAbandonedPlacementMoveSourceToLocal"
  | "completePlacementMoveToWorker"
  | "getPlacementMove"
  | "listPlacementMoves"
  | "recordPlacementMoveError"
  | "fail"
  | "get"
  | "loadWorkspaceReconciliation"
  | "beginWorkspaceReconciliation"
  | "abortWorkspaceReconciliation"
  | "listWorkspaceReconciliationOwners"
  | "list"
  | "listPendingWorkspaceResults"
  | "markWorkspaceResultPending"
  | "handoffWorkspaceResultRecovery"
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
  | "startWorkspaceResultDrain"
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
  authorize?: WorkerPlacementAuthorization;
  activate: () => WorkerActiveDispatchPlacement;
}) => Promise<WorkerActiveDispatchPlacement>;

const RECOVERY_ERROR_LIMIT = 1_024;
const boundedError = boundedWorkerError;

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

export function isCurrentActiveWorkerEnvironment(
  placement: WorkerActiveDispatchPlacement | WorkerDrainingDispatchPlacement,
  environment: ReturnType<WorkerEnvironmentService["get"]>,
): boolean {
  return Boolean(
    environment &&
    environment.state === "attached" &&
    placement.environmentId &&
    environment.environmentId === placement.environmentId &&
    placement.activeOwnerEpoch !== null &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    placement.workerBundleHash &&
    environment.bootstrapReceipt?.bundleHash === placement.workerBundleHash &&
    // A persisted bundle hash can still match a worker using an older launch shape.
    // Recovery may reuse only the currently admitted execution-context dialect.
    supportsWorkerExecutionContextLaunch(environment.bootstrapReceipt) &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === placement.sessionId,
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
    reclaimActive,
    retryFailedTeardown,
    teardownEnvironment,
  };
}

export type PlacementFailureActions = ReturnType<typeof createPlacementFailureActions>;
