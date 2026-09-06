import { randomUUID } from "node:crypto";
import {
  isExactAttachedEnvironment,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import {
  type PlacementRecoveryDeps,
  resolvePriorWorkspaceResultConflict,
} from "./placement-dispatch-pending-results.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type {
  WorkerPlacementReclaimBarriers,
  WorkerReclaimPlacement,
} from "./placement-reclaim-contract.js";
import { placementTurnOwner, reportPlacementTransition } from "./placement-record.js";
import {
  completeMovedWorkspaceTeardown,
  completeReclaimedWorkspaceTeardown,
} from "./placement-teardown.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import {
  createWorkerWorkspaceReconcileRequest,
  sessionWorkspaceRoot,
} from "./session-workspace.js";
import {
  verifyReconciledWorkspaceFinal,
  WorkerWorkspaceFinalFenceError,
} from "./workspace-finalize.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  finalizeWorkspaceResultConflicts,
  settleStagedWorkspaceResult,
} from "./workspace-result-finalize.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

export type WorkerPlacementReclaimOptions = Pick<
  WorkerPlacementReclaimBarriers,
  "runReclaimBarrier"
> &
  Pick<
    PlacementRecoveryDeps,
    | "placements"
    | "environments"
    | "workspaceOperations"
    | "prepareGatewayMove"
    | "reportWorkspaceResultConflict"
    | "resolveWorkspaceResultConflict"
  >;

export function createWorkerPlacementReclaim(options: WorkerPlacementReclaimOptions) {
  const { environments, placements } = options;
  const reclaimOnce = async (
    request: WorkerPlacementReclaimRequest,
    moveIntent?: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementAuthorization,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> =>
    await options.runReclaimBarrier({
      ...request,
      authorize,
      beforeDrain,
      begin: () => {
        const current = placements.get(request.sessionId);
        // A queued stop can observe the previous stop's completion only after
        // entering the lifecycle fence; joining an outside promise can deadlock it.
        if (
          current?.state === "reclaimed" &&
          current.sessionKey === request.sessionKey &&
          current.agentId === request.agentId
        ) {
          return current;
        }
        if ((current?.state !== "active" && current?.state !== "draining") || current.turnClaim) {
          throw new Error(
            `Session ${request.sessionKey} cannot stop cloud worker from placement ${current?.state ?? "missing"}`,
          );
        }
        const environment = environments.get(current.environmentId);
        if (!isExactAttachedEnvironment(environment, current)) {
          throw new Error("Active cloud worker does not match its session placement");
        }
        if (current.state === "draining") {
          return current;
        }
        const draining = placements.startDrain({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
        if (draining.state !== "draining") {
          throw new Error(`Session ${request.sessionKey} did not enter draining placement`);
        }
        reportPlacementTransition(onTransition, draining);
        return draining;
      },
      reclaim: async (workspace, current, reauthorize) => {
        if (current.state === "reclaimed") {
          return current;
        }
        const root = sessionWorkspaceRoot(workspace);
        const journalOwner = {
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          placementGeneration: current.generation,
        };
        const reclaimClaimId = `reclaim-${randomUUID()}`;
        const reclaimClaim = placements.claimReclaimWorkspaceResult({
          sessionId: current.sessionId,
          sessionKey: current.sessionKey,
          agentId: current.agentId,
          claimId: reclaimClaimId,
          runId: reclaimClaimId,
          owner: placementTurnOwner(current),
        });
        const reclaimResultRef = workerWorkspaceResultRef(reclaimClaim.claimId);
        let manifestAccepted = false;
        const journal = {
          load: () => placements.loadWorkspaceReconciliation(journalOwner),
          begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
            placements.beginWorkspaceReconciliation(journalOwner, next),
          commit: (manifestRef: string) => {
            placements.updateWorkspaceBaseManifest({
              claim: reclaimClaim,
              manifestRef,
            });
            manifestAccepted = true;
          },
          abort: () => placements.abortWorkspaceReconciliation(journalOwner),
        };
        const cancelUnstagedFailedReclaim = async (allowCommitted: boolean): Promise<void> => {
          await options.workspaceOperations.run(current.environmentId, async () => {
            const stillOwnsEmptyResult = (): boolean => {
              const owned = placements.get(current.sessionId);
              const currentEnvironment = environments.get(current.environmentId);
              const pendingResult = placements
                .listPendingWorkspaceResults()
                .find(
                  (pending) =>
                    pending.sessionId === reclaimClaim.sessionId &&
                    pending.claimId === reclaimClaim.claimId &&
                    pending.runId === reclaimClaim.runId,
                );
              return (
                (allowCommitted || !manifestAccepted) &&
                owned?.state === "draining" &&
                owned.turnClaim?.claimId === reclaimClaim.claimId &&
                reclaimClaim.owner.environmentId === current.environmentId &&
                reclaimClaim.owner.ownerEpoch === current.activeOwnerEpoch &&
                currentEnvironment?.state === "attached" &&
                currentEnvironment.ownerEpoch === reclaimClaim.owner.ownerEpoch &&
                currentEnvironment.attachedSessionIds.length === 1 &&
                currentEnvironment.attachedSessionIds[0] === owned.sessionId &&
                pendingResult?.workspaceAcceptedAtMs === null &&
                pendingResult.stagedResultRef === null
              );
            };
            if (!stillOwnsEmptyResult()) {
              return;
            }
            const [canonicalExists, preparedExists] = await Promise.all([
              hasWorkerWorkspaceResultRef({ root, stagedResultRef: reclaimResultRef }),
              hasWorkerWorkspaceResultRef({
                root,
                stagedResultRef: preparedWorkerWorkspaceResultRef(reclaimResultRef),
              }),
            ]);
            // Recheck after filesystem I/O while the session barrier and workspace
            // owner lock are still held. A committed manifest or durable ref keeps
            // recovery authoritative.
            if (!canonicalExists && !preparedExists && stillOwnsEmptyResult()) {
              await placements.closeWorkerTurnToolState(reclaimClaim);
              placements.cancelWorkspaceResultAndReleaseTurn(reclaimClaim);
            }
          });
        };
        const finishReclaim = async (): Promise<WorkerReclaimPlacement> => {
          const pending = journal.load();
          if (pending) {
            reauthorize?.();
            if (workspace.kind !== "local") {
              throw new Error("Repository checkpoints cannot own a local reconciliation journal");
            }
            await recoverWorkerWorkspaceReconciliation({ root, journal: pending });
            reauthorize?.();
            journal.abort();
          }
          reauthorize?.();
          const tunnel = await environments.startTunnel({
            environmentId: current.environmentId,
            ownerEpoch: current.activeOwnerEpoch,
          });
          const reclaimed = await options.workspaceOperations.run(
            current.environmentId,
            async () => {
              // Lock acquisition and every remote/filesystem step may yield; stale callers must
              // fail before the next reclaim effect, not only after teardown has completed.
              const assertCurrent = () => {
                reauthorize?.();
                const owned = placements.get(current.sessionId);
                if (
                  owned?.state !== "draining" ||
                  owned.generation !== current.generation ||
                  owned.environmentId !== current.environmentId ||
                  owned.activeOwnerEpoch !== current.activeOwnerEpoch ||
                  owned.turnClaim?.claimId !== reclaimClaim.claimId ||
                  !placements.validateWorkspaceResultClaim(reclaimClaim)
                ) {
                  throw new Error(
                    "Cloud worker stop lost its placement owner before reconciliation",
                  );
                }
              };
              assertCurrent();
              reauthorize?.();
              const quiescence = await tunnel.quiesceWorkspace(current.remoteWorkspaceDir);
              try {
                reauthorize?.();
                const reconciliation = await tunnel.reconcileWorkspace(
                  createWorkerWorkspaceReconcileRequest({
                    workspace,
                    remoteWorkspaceDir: current.remoteWorkspaceDir,
                    baseManifestRef: current.workspaceBaseManifestRef,
                    journal,
                    stagedResult: {
                      ref: reclaimResultRef,
                      record: (ref) =>
                        placements.recordStagedWorkspaceResult(
                          reclaimClaim,
                          ref,
                          workspace.kind === "repository"
                            ? workspace.repository.workspaceId
                            : undefined,
                        ),
                    },
                    assertCurrent,
                  }),
                );
                const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
                if (reconciliation.changed && !manifestAccepted) {
                  throw new Error("Cloud worker stop did not commit its reconciled workspace");
                }
                reauthorize?.();
                placements.acceptWorkspaceResult(reclaimClaim);
                const recordedStagedResultRef = placements
                  .listPendingWorkspaceResults()
                  .find(
                    (result) =>
                      result.sessionId === reclaimClaim.sessionId &&
                      result.claimId === reclaimClaim.claimId &&
                      result.runId === reclaimClaim.runId,
                  )?.stagedResultRef;
                const conflictPaths = applied?.conflictPaths ?? [];
                if (conflictPaths.length > 0 && !recordedStagedResultRef) {
                  throw new Error("Cloud worker stop conflict has no staged result reference");
                }
                const priorWorkspaceResultConflict = await resolvePriorWorkspaceResultConflict(
                  options.resolveWorkspaceResultConflict,
                  current,
                );
                reauthorize?.();
                const finalized = await finalizeWorkspaceResultConflicts({
                  placements,
                  turnClaim: reclaimClaim,
                  conflictPaths,
                  priorConflict: priorWorkspaceResultConflict,
                  stagedResultRef: recordedStagedResultRef,
                  // An unchanged stop is not a later cloud result; keep its prior fence inspectable.
                  retainPriorConflict: !reconciliation.changed,
                  workspace,
                  report: async (report) =>
                    await options.reportWorkspaceResultConflict({
                      sessionId: current.sessionId,
                      sessionKey: current.sessionKey,
                      agentId: current.agentId,
                      ...report,
                    }),
                });
                reauthorize?.();
                return await settleStagedWorkspaceResult({
                  placements,
                  turnClaim: reclaimClaim,
                  workspace,
                  stagedResultRef: recordedStagedResultRef,
                  conflictRetained: finalized.conflictRetained,
                  beforeComplete: async () => {
                    assertCurrent();
                    if (workspace.kind === "repository" && moveIntent?.target.kind === "gateway") {
                      if (!options.prepareGatewayMove) {
                        throw new Error("Repository workspace materialization is unavailable");
                      }
                      await options.prepareGatewayMove({
                        sessionId: current.sessionId,
                        sessionKey: current.sessionKey,
                        agentId: current.agentId,
                        assertCurrent,
                      });
                      assertCurrent();
                    }
                    await environments.destroy(current.environmentId);
                  },
                  complete: () => {
                    // Destroy is the final privileged effect. Once it commits, durable placement
                    // completion must finish even if caller authority closes during the await.
                    const completed = moveIntent
                      ? completeMovedWorkspaceTeardown({
                          placements,
                          turnClaim: reclaimClaim,
                          environmentId: current.environmentId,
                          ownerEpoch: current.activeOwnerEpoch,
                          operationId: moveIntent.operationId,
                        })
                      : completeReclaimedWorkspaceTeardown({
                          placements,
                          turnClaim: reclaimClaim,
                          environmentId: current.environmentId,
                          ownerEpoch: current.activeOwnerEpoch,
                        });
                    // Publish the committed owner before cleanup refs and the tunnel can yield.
                    reportPlacementTransition(onTransition, completed);
                    return completed;
                  },
                  validateCompleted: (completed) => {
                    const expectedState = moveIntent ? "local" : "reclaimed";
                    if (completed.state !== expectedState) {
                      throw new Error(
                        `Cloud worker teardown did not produce ${expectedState} placement`,
                      );
                    }
                  },
                });
              } finally {
                if (isExactAttachedEnvironment(environments.get(current.environmentId), current)) {
                  await quiescence.resume();
                }
              }
            },
          );
          if (reclaimed.state !== "local" && reclaimed.state !== "reclaimed") {
            throw new Error("Cloud worker teardown produced a nonterminal placement");
          }
          try {
            await environments.stopTunnel(current.environmentId, current.activeOwnerEpoch);
          } catch {
            // Provider teardown is authoritative; local tunnel cleanup is best effort.
          }
          return reclaimed;
        };
        try {
          return await finishReclaim();
        } catch (error) {
          // An unstaged final-fence failure is retryable even after an unchanged
          // manifest commit; the journal remains authoritative for the next attempt.
          await cancelUnstagedFailedReclaim(
            error instanceof WorkerWorkspaceFinalFenceError && error.reclaimDisposition === "retry",
          ).catch(() => undefined);
          const pendingReclaimResult = placements
            .listPendingWorkspaceResults()
            .find(
              (pending) =>
                pending.sessionId === reclaimClaim.sessionId &&
                pending.claimId === reclaimClaim.claimId &&
                pending.runId === reclaimClaim.runId,
            );
          if (pendingReclaimResult && pendingReclaimResult.workspaceAcceptedAtMs !== null) {
            placements.handoffWorkspaceResultRecovery(reclaimClaim);
            // The tracked sweep retries cleanup after this lifecycle/placement fence releases.
            // Awaiting it here can join provisioning recovery queued behind our own fence.
          }
          throw error;
        }
      },
    });

  return reclaimOnce;
}
