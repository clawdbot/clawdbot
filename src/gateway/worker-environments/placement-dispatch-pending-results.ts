import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  isCurrentActiveWorkerEnvironment,
  workerDisappearanceError,
  type PlacementFailureActions,
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
import {
  isCurrentWorkerWorkspacePendingResultOwner,
  type WorkerWorkspacePendingResult,
} from "./placement-workspace-result.js";
import {
  createWorkerWorkspaceReconcileRequest,
  recoverSessionWorkspaceCheckpoint,
  sessionWorkspaceRoot,
  type WorkerSessionWorkspace,
} from "./session-workspace.js";
import { boundedWorkerError } from "./worker-error.js";
import type {
  WorkerWorkspaceRecoveryFailureReport,
  WorkerWorkspaceResultConflict,
  WorkspaceResultConflictLookup,
} from "./workspace-conflicts.js";
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
  failure: PlacementFailureActions;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspace: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<WorkerSessionWorkspace>;
  reportWorkspaceResultConflict: (
    params: { sessionId: string; sessionKey: string; agentId: string } & (
      | { paths: string[]; stagedResultRef: string; totalCount: number }
      | { cleared: true }
    ),
  ) => Promise<void>;
  reportWorkspaceResultRecoveryFailure?: (
    recovery: WorkerWorkspaceRecoveryFailureReport,
  ) => Promise<void>;
  resolveWorkspaceResultConflict: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<WorkspaceResultConflictLookup>;
  recoverPlacementMoves?: (environmentId?: string) => Promise<Set<string>>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  prepareGatewayMove?: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    assertCurrent: () => void;
  }) => Promise<void>;
};

const log = createSubsystemLogger("gateway/worker-placement");

export async function resolvePriorWorkspaceResultConflict(
  resolve: PlacementRecoveryDeps["resolveWorkspaceResultConflict"],
  placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    workspaceResultConflict?: WorkerWorkspaceResultConflict;
  },
): Promise<WorkerWorkspaceResultConflict | undefined> {
  if (placement.workspaceResultConflict) {
    return placement.workspaceResultConflict;
  }
  const lookup = await resolve(placement);
  if (lookup.kind === "conflict") {
    return lookup.conflict;
  }
  if (lookup.kind === "unknown") {
    log.warn(
      `Cloud workspace conflict state unknown sessionId=${boundedWorkerError(placement.sessionId, 128)} reason=${lookup.reason}; preserving prior conflict state`,
    );
    // Undefined means no prior knowledge to finalizeWorkspaceResultConflicts: it cannot
    // clear the retained report or delete its unseen staged ref. The warning signals this.
  }
  return undefined;
}

type WorkerOwnedPendingPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "active" | "draining" }
>;

async function prepareAcceptedPublication(
  deps: PlacementRecoveryDeps,
  claim: WorkerSessionTurnClaim,
): Promise<void> {
  if (deps.prepareAcceptedWorkspacePublication) {
    await deps.prepareAcceptedWorkspacePublication(claim).catch(() => undefined);
  }
}

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
  const resolveWorkspace = async (
    placement: WorkerDispatchPlacement,
    pending: WorkerWorkspacePendingResult,
  ): Promise<WorkerSessionWorkspace> => {
    const workspace = await deps.resolveWorkspace(placement);
    if (!pending.repositoryWorkspaceId) {
      return workspace;
    }
    const repository = getSessionRepositoryWorkspaceStore().get(pending.repositoryWorkspaceId);
    if (
      !repository ||
      repository.agentId !== placement.agentId ||
      repository.sessionKey !== placement.sessionKey ||
      (workspace.kind === "repository" &&
        workspace.repository.workspaceId !== pending.repositoryWorkspaceId)
    ) {
      throw new Error("Pending repository checkpoint lost its exact session workspace owner");
    }
    // An explicit Gateway move may already have bound a local worktree. The
    // result's recorded source still owns its immutable artifact until settlement.
    return { kind: "repository", repository };
  };
  const prepareGatewayMove = async (
    placement: WorkerOwnedPendingPlacement,
    turnClaim: WorkerSessionTurnClaim,
  ) => {
    const move = placements.getPlacementMove(placement.sessionId);
    if (move?.target.kind !== "gateway") {
      return;
    }
    await deps.prepareGatewayMove?.({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      assertCurrent: () => {
        if (
          !placements.validateWorkspaceResultClaim(turnClaim) ||
          placements.getPlacementMove(placement.sessionId)?.operationId !== move.operationId
        ) {
          throw new Error("Recovered Gateway move lost its workspace result owner");
        }
      },
    });
  };
  const destroyPendingEnvironment = async (placement: WorkerOwnedPendingPlacement) => {
    const current = environments.get(placement.environmentId);
    // Drain advances the epoch, but store.requestDestroy is monotonic and forbids
    // reattachment. Retry its cleanup; a live replacement still needs the exact epoch.
    if (
      current &&
      current.state !== "destroyed" &&
      (current.ownerEpoch === placement.activeOwnerEpoch || current.destroyRequestedAtMs !== null)
    ) {
      await environments.destroy(placement.environmentId);
    }
  };
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
          const workspace = await resolveWorkspace(placement, pending);
          if (workspace.kind === "local") {
            await deleteStagedWorkerWorkspaceResult({
              root: workspace.path,
              stagedResultRef: pending.stagedResultRef,
            });
          }
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
      const workspace = await resolveWorkspace(active, pending);
      const root = sessionWorkspaceRoot(workspace);
      const priorWorkspaceResultConflict = await resolvePriorWorkspaceResultConflict(
        deps.resolveWorkspaceResultConflict,
        active,
      );
      const canonicalStagedResultRef = workerWorkspaceResultRef(turnClaim.claimId);
      let stagedResultRef = pending.stagedResultRef;
      if (
        !stagedResultRef &&
        (await hasWorkerWorkspaceResultRef({
          root,
          stagedResultRef: canonicalStagedResultRef,
        }))
      ) {
        placements.recordStagedWorkspaceResult(
          turnClaim,
          canonicalStagedResultRef,
          workspace.kind === "repository" ? workspace.repository.workspaceId : undefined,
        );
        stagedResultRef = canonicalStagedResultRef;
        stagedResultOwners.add(pending.sessionId);
      }
      if (workspace.kind === "local" && stagedResultRef && pending.workspaceAcceptedAtMs !== null) {
        const canonicalExists = await hasWorkerWorkspaceResultRef({
          root,
          stagedResultRef,
        });
        if (!canonicalExists) {
          const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
          if (await hasWorkerWorkspaceResultRef({ root, stagedResultRef: cleanupRef })) {
            stagedResultRef = cleanupRef;
          }
        }
      }
      const hasPreparedResult =
        !stagedResultRef &&
        (await hasWorkerWorkspaceResultRef({
          root,
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
        ? await hasWorkerWorkspaceResultRef({ root, stagedResultRef })
        : false;
      if (stagedResultRef && !stagedResultExists) {
        if (workspace.kind === "repository") {
          throw new Error(
            "Repository checkpoint is missing; restore its artifact before retrying recovery",
          );
        }
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
        await prepareGatewayMove(active, turnClaim);
        await destroyPendingEnvironment(active);
        await prepareAcceptedPublication(deps, turnClaim);
        await deps.publishAcceptedWorkspace?.(turnClaim);
        completeRecoveredWorkspaceTeardown({ placements, placement: active, turnClaim });
        await environments
          .stopTunnel(active.environmentId, active.activeOwnerEpoch)
          .catch(() => undefined);
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
      if (stagedResultRef) {
        let ownedStagedResultRef = stagedResultRef;
        // A staged result must never be destroyed by environment lifecycle.
        // Keep its fence and placement until the local apply is durably accepted.
        await deps.workspaceOperations.run(active.environmentId, async () => {
          if (!placements.validateWorkspaceResultClaim(turnClaim)) {
            throw new Error("Recovered workspace result lost its placement owner");
          }
          let conflictPaths: string[] = [];
          if (workspace.kind === "repository") {
            await recoverSessionWorkspaceCheckpoint({
              workspace,
              checkpointRef: ownedStagedResultRef,
              assertCurrent: () => {
                if (!placements.validateWorkspaceResultClaim(turnClaim)) {
                  throw new Error("Recovered repository checkpoint lost its placement owner");
                }
              },
              onAccepted: journal.commit,
            });
          } else {
            const interrupted = journal.load();
            const alreadyApplied = interrupted?.appliedManifestRef !== undefined;
            if (interrupted && !alreadyApplied) {
              await recoverWorkerWorkspaceReconciliation({ root, journal: interrupted });
              journal.abort();
            }
            const reconciliation = await applyStagedWorkerWorkspaceResult({
              root,
              stagedResultRef: ownedStagedResultRef,
              expectedBaseManifestRef: active.workspaceBaseManifestRef,
              alreadyAccepted: pending.workspaceAcceptedAtMs !== null || alreadyApplied,
              journal,
            });
            await reconciliation.verifyLocalStable();
            conflictPaths = reconciliation.conflictPaths;
          }
          if (pending.workspaceAcceptedAtMs === null) {
            await prepareAcceptedPublication(deps, turnClaim);
            placements.acceptWorkspaceResult(turnClaim);
          }
          if (conflictPaths.length > 0 && isWorkerWorkspaceResultCleanupRef(ownedStagedResultRef)) {
            await restoreStagedWorkerWorkspaceResultFromCleanup({
              root,
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
            workspace,
            report: async (report) =>
              await deps.reportWorkspaceResultConflict({
                sessionId: active.sessionId,
                sessionKey: active.sessionKey,
                agentId: active.agentId,
                ...report,
              }),
          });
          await deps.publishAcceptedWorkspace?.(turnClaim);
          await settleStagedWorkspaceResult({
            placements,
            turnClaim,
            workspace,
            stagedResultRef: ownedStagedResultRef,
            conflictRetained: finalized.conflictRetained,
            beforeComplete: async () => {
              await prepareGatewayMove(active, turnClaim);
              await destroyPendingEnvironment(active);
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
          await prepareAcceptedPublication(deps, turnClaim);
          await deps.publishAcceptedWorkspace?.(turnClaim);
          await prepareGatewayMove(active, turnClaim);
          completeRecoveredWorkspaceTeardown({ placements, placement: active, turnClaim });
          continue;
        }
        const failed = placements.failWorkspaceResultAndReleaseTurn(
          pending,
          workerDisappearanceError(environment) ??
            new Error(`Pending cloud workspace result lost its worker: ${pending.sessionId}`),
        );
        if (failed.state === "failed") {
          await failure.retryFailedTeardown(failed);
        }
        continue;
      }
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
          const reconciliation = await tunnel.reconcileWorkspace(
            createWorkerWorkspaceReconcileRequest({
              workspace,
              remoteWorkspaceDir: active.remoteWorkspaceDir,
              baseManifestRef: active.workspaceBaseManifestRef,
              journal,
              stagedResult: {
                ref: canonicalStagedResultRef,
                record: (ref) =>
                  placements.recordStagedWorkspaceResult(
                    turnClaim,
                    ref,
                    workspace.kind === "repository" ? workspace.repository.workspaceId : undefined,
                  ),
              },
              assertCurrent: () => {
                if (!placements.validateWorkspaceResultClaim(turnClaim)) {
                  throw new Error("Recovered workspace result lost its placement owner");
                }
              },
            }),
          );
          const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
          await prepareAcceptedPublication(deps, turnClaim);
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
            workspace,
            report: async (report) =>
              await deps.reportWorkspaceResultConflict({
                sessionId: active.sessionId,
                sessionKey: active.sessionKey,
                agentId: active.agentId,
                ...report,
              }),
          });
          await deps.publishAcceptedWorkspace?.(turnClaim);
          await settleStagedWorkspaceResult({
            placements,
            turnClaim,
            workspace,
            stagedResultRef: recordedStagedResultRef,
            conflictRetained: finalized.conflictRetained,
            beforeComplete: async () => {
              await prepareGatewayMove(active, turnClaim);
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
    } catch (error) {
      try {
        const current = placements.get(pending.sessionId);
        const currentPending = placements
          .listPendingWorkspaceResults()
          .find(
            (candidate) =>
              candidate.sessionId === pending.sessionId &&
              candidate.environmentId === pending.environmentId &&
              candidate.ownerEpoch === pending.ownerEpoch &&
              candidate.placementGeneration === pending.placementGeneration &&
              candidate.claimId === pending.claimId &&
              candidate.runId === pending.runId &&
              candidate.gatewayInstanceId === pending.gatewayInstanceId,
          );
        if (currentPending && isCurrentWorkerWorkspacePendingResultOwner(current, currentPending)) {
          await deps.reportWorkspaceResultRecoveryFailure?.({
            sessionId: current.sessionId,
            sessionKey: current.sessionKey,
            agentId: current.agentId,
            error: boundedWorkerError(error),
          });
        }
      } catch {
        // Transcript reporting must not weaken the durable recovery fence.
      }
    }
  }
  if (cleanupOrphans) {
    const retainedRefs = () =>
      new Set(
        placements
          .listPendingWorkspaceResults()
          .flatMap((pending) =>
            pending.stagedResultRef
              ? [cleanupWorkerWorkspaceResultRef(pending.stagedResultRef)]
              : [],
          ),
      );
    const cleanedWorkspaceRoots = new Set<string>();
    for (const placement of placements.list()) {
      try {
        const workspace = await deps.resolveWorkspace(placement);
        if (workspace.kind === "repository") {
          continue;
        }
        const root = workspace.path;
        if (!cleanedWorkspaceRoots.has(root)) {
          cleanedWorkspaceRoots.add(root);
          await deleteWorkerWorkspaceResultCleanupRefs({
            root,
            retainedRefs,
          });
        }
      } catch {
        // Cleanup refs are independently retryable after the next restart.
      }
    }
  }
  return new Set([
    ...stagedResultOwners,
    ...placements.listPendingWorkspaceResults().map((pending) => pending.sessionId),
  ]);
}
