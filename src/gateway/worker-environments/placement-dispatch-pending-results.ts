import {
  isCurrentActiveWorkerEnvironment,
  type PlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import { placementTurnOwner } from "./placement-record.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import {
  completeMovedWorkspaceTeardown,
  completeReclaimedWorkspaceTeardown,
} from "./placement-teardown.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerWorkspaceResultConflict } from "./workspace-conflicts.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  finalizeWorkspaceResultConflicts,
  settleStagedWorkspaceResult,
} from "./workspace-result-finalize.js";
import {
  applyStagedWorkerWorkspaceResult,
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  isWorkerWorkspaceResultCleanupRef,
  preparedWorkerWorkspaceResultRef,
  restoreStagedWorkerWorkspaceResultFromCleanup,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

export type PlacementRecoveryDeps = {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runActivationBarrier: WorkerActivationBarrier;
  failure: PlacementFailureActions;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspacePath: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>;
  reportWorkspaceResultConflict: (
    params: { sessionId: string; sessionKey: string; agentId: string } & (
      | { paths: string[]; stagedResultRef: string; totalCount: number }
      | { cleared: true }
    ),
  ) => Promise<void>;
  resolveWorkspaceResultConflict: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<WorkerWorkspaceResultConflict | undefined>;
  recoverPlacementMoves?: () => Promise<Set<string>>;
};

function pendingWorkerLossError(
  environment: ReturnType<WorkerEnvironmentService["get"]>,
  sessionId: string,
): Error {
  if (!environment) {
    return new Error("cloud worker disappeared: environment record missing");
  }
  if (
    environment.state === "destroyed" ||
    environment.state === "failed" ||
    environment.state === "orphaned"
  ) {
    return new Error(
      `cloud worker disappeared: ${environment.error ?? `environment state ${environment.state}`}`,
    );
  }
  return new Error(`Pending cloud workspace result lost its worker: ${sessionId}`);
}

type WorkerOwnedPendingPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "active" | "draining" }
>;

function completeRecoveredWorkspaceTeardown(params: {
  placements: WorkerDispatchPlacementStore;
  placement: WorkerOwnedPendingPlacement;
  turnClaim: WorkerSessionTurnClaim;
}) {
  const move = params.placements.getPlacementMove(params.placement.sessionId);
  return move
    ? completeMovedWorkspaceTeardown({
        placements: params.placements,
        turnClaim: params.turnClaim,
        environmentId: params.placement.environmentId,
        ownerEpoch: params.placement.activeOwnerEpoch,
        operationId: move.operationId,
      })
    : completeReclaimedWorkspaceTeardown({
        placements: params.placements,
        turnClaim: params.turnClaim,
        environmentId: params.placement.environmentId,
        ownerEpoch: params.placement.activeOwnerEpoch,
      });
}

export async function recoverPendingWorkspaceResults(
  deps: PlacementRecoveryDeps,
  cleanupOrphans: boolean,
  environmentId?: string,
): Promise<Set<string>> {
  const { environments, failure, placements } = deps;
  const stagedResultOwners = new Set<string>();
  for (const pending of placements.listPendingWorkspaceResults()) {
    if (pending.stagedResultRef) {
      stagedResultOwners.add(pending.sessionId);
    }
    const sameGatewayInstance =
      pending.gatewayInstanceId === placements.workspaceResultInstanceId();
    if (sameGatewayInstance && pending.recoveryRequestedAtMs === null) {
      continue;
    }
    const placement = placements.get(pending.sessionId);
    if (environmentId !== undefined && placement?.environmentId !== environmentId) {
      continue;
    }
    try {
      let active =
        placement?.state === "active" || placement?.state === "draining" ? placement : undefined;
      const turnClaim =
        active &&
        active.environmentId === pending.environmentId &&
        active.activeOwnerEpoch === pending.ownerEpoch
          ? {
              sessionId: active.sessionId,
              claimId: pending.claimId,
              runId: pending.runId,
              placementGeneration: pending.placementGeneration,
              owner: placementTurnOwner(active),
            }
          : undefined;
      if (!active || !turnClaim || !placements.validateWorkspaceResultClaim(turnClaim)) {
        if (pending.stagedResultRef && pending.workspaceAcceptedAtMs === null) {
          // A staged unaccepted result outlives stale placement ownership. Only
          // explicit operator abandonment may delete its durable Git ref.
          continue;
        }
        if (pending.stagedResultRef) {
          if (!placement) {
            throw new Error(
              `Staged cloud workspace result lost its placement: ${pending.sessionId}`,
            );
          }
          const root = await deps.resolveWorkspacePath(placement);
          await deleteStagedWorkerWorkspaceResult({
            root,
            stagedResultRef: pending.stagedResultRef,
          });
        }
        if (placement?.state === "active" || placement?.state === "draining") {
          const failed = placements.failWorkspaceResultAndReleaseTurn(
            pending,
            new Error(`Pending cloud workspace result has no active claim: ${pending.sessionId}`),
          );
          if (failed.state === "failed") {
            await failure.retryFailedTeardown(failed);
          }
        } else {
          placements.abandonWorkspaceResult(pending);
        }
        continue;
      }
      const localPath = await deps.resolveWorkspacePath(active);
      const priorWorkspaceResultConflict =
        active.workspaceResultConflict ?? (await deps.resolveWorkspaceResultConflict(active));
      const canonicalStagedResultRef = workerWorkspaceResultRef(turnClaim.claimId);
      let stagedResultRef = pending.stagedResultRef;
      if (
        !stagedResultRef &&
        (await hasWorkerWorkspaceResultRef({
          root: localPath,
          stagedResultRef: canonicalStagedResultRef,
        }))
      ) {
        placements.recordStagedWorkspaceResult(turnClaim, canonicalStagedResultRef);
        stagedResultRef = canonicalStagedResultRef;
        stagedResultOwners.add(pending.sessionId);
      }
      if (stagedResultRef && pending.workspaceAcceptedAtMs !== null) {
        const canonicalExists = await hasWorkerWorkspaceResultRef({
          root: localPath,
          stagedResultRef,
        });
        if (!canonicalExists) {
          const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
          if (await hasWorkerWorkspaceResultRef({ root: localPath, stagedResultRef: cleanupRef })) {
            stagedResultRef = cleanupRef;
          }
        }
      }
      const hasPreparedResult =
        !stagedResultRef &&
        (await hasWorkerWorkspaceResultRef({
          root: localPath,
          stagedResultRef: preparedWorkerWorkspaceResultRef(canonicalStagedResultRef),
        }));
      const environment = environments.get(active.environmentId);
      if (
        environment?.state === "attached" &&
        (environment.attachedSessionIds.length !== 1 ||
          environment.attachedSessionIds[0] !== active.sessionId)
      ) {
        // This result cannot own teardown unless the environment is attached
        // exclusively to this session. Preserve the fence until ownership is exact.
        continue;
      }
      const teardownRequired =
        !sameGatewayInstance ||
        Boolean(stagedResultRef) ||
        (pending.workspaceAcceptedAtMs !== null && environment?.state === "destroyed");
      if (active.state === "active" && teardownRequired) {
        const draining = placements.startWorkspaceResultDrain(turnClaim);
        if (draining.state !== "draining") {
          throw new Error(`Pending workspace result did not drain session ${active.sessionId}`);
        }
        active = draining;
      }
      const stagedResultExists = stagedResultRef
        ? await hasWorkerWorkspaceResultRef({ root: localPath, stagedResultRef })
        : false;
      if (stagedResultRef && !stagedResultExists) {
        if (pending.workspaceAcceptedAtMs === null) {
          // An unaccepted result with a missing ref has no proof of apply.
          // Preserve its fence for operator inspection instead of guessing.
          continue;
        }
        // Clean refs are deleted while their accepted fence still exists. A
        // crash after deletion resumes here and can safely finish ownership.
        if (turnClaim.owner.kind === "worker") {
          await placements.closeWorkerTurnToolState(turnClaim);
        }
        if (
          environment &&
          environment.state !== "destroyed" &&
          environment.ownerEpoch === active.activeOwnerEpoch
        ) {
          await environments.destroy(active.environmentId);
        }
        completeRecoveredWorkspaceTeardown({ placements, placement: active, turnClaim });
        await environments
          .stopTunnel(active.environmentId, active.activeOwnerEpoch)
          .catch(() => undefined);
        continue;
      }
      if (stagedResultRef) {
        let ownedStagedResultRef = stagedResultRef;
        // A staged result must never be destroyed by environment lifecycle.
        // Keep its fence and placement until the local apply is durably accepted.
        const owner = {
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          placementGeneration: pending.placementGeneration,
        };
        const journal = {
          load: () => placements.loadWorkspaceReconciliation(owner),
          begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
            placements.beginWorkspaceReconciliation(owner, next),
          commit: (manifestRef: string) =>
            placements.updateWorkspaceBaseManifest({ claim: turnClaim, manifestRef }),
          abort: () => placements.abortWorkspaceReconciliation(owner),
        };
        await deps.workspaceOperations.run(active.environmentId, async () => {
          if (!placements.validateWorkspaceResultClaim(turnClaim)) {
            throw new Error("Recovered workspace result lost its placement owner");
          }
          const interrupted = journal.load();
          const alreadyApplied = interrupted?.appliedManifestRef !== undefined;
          if (interrupted && !alreadyApplied) {
            await recoverWorkerWorkspaceReconciliation({ root: localPath, journal: interrupted });
            journal.abort();
          }
          const reconciliation = await applyStagedWorkerWorkspaceResult({
            root: localPath,
            stagedResultRef: ownedStagedResultRef,
            expectedBaseManifestRef: active.workspaceBaseManifestRef,
            alreadyAccepted: pending.workspaceAcceptedAtMs !== null || alreadyApplied,
            journal,
          });
          await reconciliation.verifyLocalStable();
          const conflictPaths = reconciliation.conflictPaths;
          if (pending.workspaceAcceptedAtMs === null) {
            placements.acceptWorkspaceResult(turnClaim);
          }
          if (conflictPaths.length > 0 && isWorkerWorkspaceResultCleanupRef(ownedStagedResultRef)) {
            await restoreStagedWorkerWorkspaceResultFromCleanup({
              root: localPath,
              cleanupRef: ownedStagedResultRef,
              stagedResultRef: canonicalStagedResultRef,
            });
            ownedStagedResultRef = canonicalStagedResultRef;
          }
          const finalized = await finalizeWorkspaceResultConflicts({
            placements,
            turnClaim,
            conflictPaths,
            priorConflict: priorWorkspaceResultConflict,
            stagedResultRef: ownedStagedResultRef,
            root: localPath,
            report: async (report) =>
              await deps.reportWorkspaceResultConflict({
                sessionId: active.sessionId,
                sessionKey: active.sessionKey,
                agentId: active.agentId,
                ...report,
              }),
          });
          await settleStagedWorkspaceResult({
            placements,
            turnClaim,
            root: localPath,
            stagedResultRef: ownedStagedResultRef,
            conflictRetained: finalized.conflictRetained,
            beforeComplete: async () => {
              const currentEnvironment = environments.get(active.environmentId);
              if (
                currentEnvironment &&
                currentEnvironment.state !== "destroyed" &&
                currentEnvironment.ownerEpoch === active.activeOwnerEpoch
              ) {
                await environments.destroy(active.environmentId);
              }
            },
            complete: () =>
              completeRecoveredWorkspaceTeardown({ placements, placement: active, turnClaim }),
          });
          await environments
            .stopTunnel(active.environmentId, active.activeOwnerEpoch)
            .catch(() => undefined);
        });
        continue;
      }
      if (!isCurrentActiveWorkerEnvironment(active, environment)) {
        if (hasPreparedResult) {
          // Verification did not publish this prepared snapshot before the
          // crash. Preserve the fence for retry or operator inspection.
          continue;
        }
        if (pending.workspaceAcceptedAtMs !== null && environment?.state === "destroyed") {
          completeRecoveredWorkspaceTeardown({ placements, placement: active, turnClaim });
          continue;
        }
        const failed = placements.failWorkspaceResultAndReleaseTurn(
          pending,
          pendingWorkerLossError(environment, pending.sessionId),
        );
        if (failed.state === "failed") {
          await failure.retryFailedTeardown(failed);
        }
        continue;
      }
      const owner = {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: pending.placementGeneration,
      };
      const journal = {
        load: () => placements.loadWorkspaceReconciliation(owner),
        begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
          placements.beginWorkspaceReconciliation(owner, next),
        commit: (manifestRef: string) =>
          placements.updateWorkspaceBaseManifest({ claim: turnClaim, manifestRef }),
        abort: () => placements.abortWorkspaceReconciliation(owner),
      };
      const tunnel = await environments.startTunnel({
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      await deps.workspaceOperations.run(active.environmentId, async () => {
        if (!placements.validateWorkspaceResultClaim(turnClaim)) {
          throw new Error("Recovered workspace result lost its placement owner");
        }
        const quiescence = await tunnel.quiesceWorkspace(active.remoteWorkspaceDir);
        let quiescenceHandled = false;
        try {
          const reconciliation = await tunnel.reconcileWorkspace({
            localPath,
            remoteWorkspaceDir: active.remoteWorkspaceDir,
            baseManifestRef: active.workspaceBaseManifestRef,
            journal: {
              ...journal,
            },
            stagedResult: {
              ref: canonicalStagedResultRef,
              record: (ref) => placements.recordStagedWorkspaceResult(turnClaim, ref),
            },
          });
          const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
          placements.acceptWorkspaceResult(turnClaim);
          const recordedStagedResultRef = placements
            .listPendingWorkspaceResults()
            .find(
              (result) =>
                result.sessionId === turnClaim.sessionId &&
                result.claimId === turnClaim.claimId &&
                result.runId === turnClaim.runId,
            )?.stagedResultRef;
          const conflictPaths = applied?.conflictPaths ?? [];
          if (conflictPaths.length > 0 && !recordedStagedResultRef) {
            throw new Error("Recovered cloud workspace conflict has no staged result reference");
          }
          const finalized = await finalizeWorkspaceResultConflicts({
            placements,
            turnClaim,
            conflictPaths,
            priorConflict: priorWorkspaceResultConflict,
            stagedResultRef: recordedStagedResultRef,
            root: localPath,
            report: async (report) =>
              await deps.reportWorkspaceResultConflict({
                sessionId: active.sessionId,
                sessionKey: active.sessionKey,
                agentId: active.agentId,
                ...report,
              }),
          });
          await settleStagedWorkspaceResult({
            placements,
            turnClaim,
            root: localPath,
            stagedResultRef: recordedStagedResultRef,
            conflictRetained: finalized.conflictRetained,
            beforeComplete: async () => {
              if (sameGatewayInstance) {
                await quiescence.resume();
              } else {
                await environments.destroy(active.environmentId);
              }
              quiescenceHandled = true;
            },
            ...(sameGatewayInstance
              ? {}
              : {
                  complete: () =>
                    completeRecoveredWorkspaceTeardown({
                      placements,
                      placement: active,
                      turnClaim,
                    }),
                }),
            afterComplete: async () => {
              if (!sameGatewayInstance) {
                await environments
                  .stopTunnel(active.environmentId, active.activeOwnerEpoch)
                  .catch(() => undefined);
              }
            },
          });
        } finally {
          if (!quiescenceHandled) {
            await quiescence.resume();
          }
        }
      });
    } catch {
      // Keep the result, claim, and environment fenced. The next sweep retries.
    }
  }
  if (cleanupOrphans) {
    const retainedCleanupRefs = new Set(
      placements
        .listPendingWorkspaceResults()
        .flatMap((pending) =>
          pending.stagedResultRef ? [cleanupWorkerWorkspaceResultRef(pending.stagedResultRef)] : [],
        ),
    );
    const cleanedWorkspaceRoots = new Set<string>();
    for (const placement of placements.list()) {
      try {
        const root = await deps.resolveWorkspacePath(placement);
        if (!cleanedWorkspaceRoots.has(root)) {
          cleanedWorkspaceRoots.add(root);
          await deleteWorkerWorkspaceResultCleanupRefs({
            root,
            retainedRefs: retainedCleanupRefs,
          });
        }
      } catch {
        // Cleanup refs are independently retryable on the next startup sweep.
      }
    }
  }
  return new Set([
    ...stagedResultOwners,
    ...placements.listPendingWorkspaceResults().map((pending) => pending.sessionId),
  ]);
}
