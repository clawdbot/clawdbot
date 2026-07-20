import { randomUUID } from "node:crypto";
import {
  createPlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { type WorkerEnvironmentService, workerEnvironmentIdForIdempotencyKey } from "./service.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

type WorkerLocalDispatchBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  startDispatch: () => WorkerDispatchPlacement;
}) => Promise<WorkerDispatchPlacement>;

type WorkerReclaimedPlacement = Extract<WorkerDispatchPlacement, { state: "reclaimed" }>;
type WorkerPlacementReclaimBarrier = (
  params: WorkerPlacementReclaimRequest & {
    reclaim: (localPath: string) => Promise<WorkerReclaimedPlacement>;
  },
) => Promise<WorkerReclaimedPlacement>;

type WorkerPlacementDispatchOptions = {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runLocalBarrier: WorkerLocalDispatchBarrier;
  runActivationBarrier: WorkerActivationBarrier;
  runReclaimBarrier: WorkerPlacementReclaimBarrier;
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
};

function requireProvisionedEnvironment(
  environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>,
  expectedEnvironmentId: string,
): { environmentId: string; ownerEpoch: number; bundleHash: string } {
  if (
    (environment.state !== "ready" && environment.state !== "idle") ||
    !environment.bootstrapReceipt ||
    environment.environmentId !== expectedEnvironmentId
  ) {
    throw new Error(`Worker environment is not dispatchable: ${environment.state}`);
  }
  return {
    environmentId: environment.environmentId,
    ownerEpoch: environment.ownerEpoch,
    bundleHash: environment.bootstrapReceipt.bundleHash,
  };
}

export function createWorkerPlacementDispatchService(options: WorkerPlacementDispatchOptions) {
  const { environments, placements } = options;
  const failure = createPlacementFailureActions({ environments, placements });
  const recovery = createPlacementRecoveryActions({
    environments,
    failure,
    placements,
    runActivationBarrier: options.runActivationBarrier,
    resolveWorkspacePath: options.resolveWorkspacePath,
    reportWorkspaceResultConflict: options.reportWorkspaceResultConflict,
    resolveWorkspaceResultConflict: options.resolveWorkspaceResultConflict,
    workspaceOperations: options.workspaceOperations,
  });

  const dispatch = async (
    request: WorkerPlacementDispatchRequest,
  ): Promise<WorkerActiveDispatchPlacement> => {
    let placement: WorkerDispatchPlacement | undefined;
    let environmentId: string | null = null;
    let ownerEpoch: number | null = null;
    try {
      placement = await options.runLocalBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        startDispatch: () => {
          placement = placements.startDispatch({
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
          });
          return placement;
        },
      });
      const localPath = await options.resolveWorkspacePath(request);
      const idempotencyKey = `session-dispatch:${request.sessionId}:${placement.generation}`;
      const expectedEnvironmentId = workerEnvironmentIdForIdempotencyKey(idempotencyKey);
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: expectedEnvironmentId },
      });
      const environment = await environments.create(request.profileId, idempotencyKey);
      const provisioned = requireProvisionedEnvironment(environment, expectedEnvironmentId);
      environmentId = provisioned.environmentId;
      ownerEpoch = provisioned.ownerEpoch;
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: placement.generation,
        patch: {
          environmentId,
          workerBundleHash: provisioned.bundleHash,
        },
      });
      const readyTunnel = await environments.startTunnel({ environmentId, ownerEpoch });
      const synced = await readyTunnel.syncWorkspace({
        localPath,
        sessionId: request.sessionId,
        generation: placement.generation,
      });
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: placement.generation,
        patch: {
          workspaceBaseManifestRef: synced.manifestRef,
          remoteWorkspaceDir: synced.remoteWorkspaceDir,
        },
      });
      const credential = await environments.attachSession({
        environmentId,
        ownerEpoch,
        sessionId: request.sessionId,
      });
      ownerEpoch = credential.ownerEpoch;
      await environments.startTunnel({ environmentId, ownerEpoch });
      const startingPlacement = placement;
      const activePlacement = await options.runActivationBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        activate: () => {
          const activated = placements.transition({
            sessionId: request.sessionId,
            from: "starting",
            to: "active",
            expectedGeneration: startingPlacement.generation,
            patch: { activeOwnerEpoch: ownerEpoch },
          });
          if (activated.state !== "active") {
            throw new Error("Worker dispatch activation did not produce an active placement");
          }
          return activated;
        },
      });
      return activePlacement;
    } catch (error) {
      const current = placement ? placements.get(request.sessionId) : undefined;
      if (current && current.state !== "local" && current.state !== "reclaimed") {
        if (current.state === "active") {
          await failure.failActive(current, error);
        } else {
          const currentEnvironmentId = environmentId ?? current.environmentId;
          const currentEnvironment = currentEnvironmentId
            ? environments.get(currentEnvironmentId)
            : undefined;
          await failure.teardownEnvironment({
            placement: current,
            environmentId: currentEnvironment?.environmentId ?? null,
            ownerEpoch: ownerEpoch ?? currentEnvironment?.ownerEpoch ?? null,
            primaryError: error,
          });
        }
      }
      throw error;
    }
  };

  const reclaimOnce = async (
    request: WorkerPlacementReclaimRequest,
  ): Promise<WorkerReclaimedPlacement> =>
    await options.runReclaimBarrier({
      ...request,
      reclaim: async (localPath) => {
        const current = placements.get(request.sessionId);
        if (current?.state !== "active" || current.turnClaim) {
          throw new Error(
            `Session ${request.sessionKey} cannot stop cloud worker from placement ${current?.state ?? "missing"}`,
          );
        }
        const environment = environments.get(current.environmentId);
        if (
          !environment ||
          environment.state !== "attached" ||
          environment.ownerEpoch !== current.activeOwnerEpoch ||
          environment.attachedSessionIds.length !== 1 ||
          environment.attachedSessionIds[0] !== current.sessionId
        ) {
          throw new Error("Active cloud worker does not match its session placement");
        }
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
          owner: {
            kind: "worker",
            environmentId: current.environmentId,
            ownerEpoch: current.activeOwnerEpoch,
          },
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
        const cancelEmptyFailedReclaim = async (): Promise<void> => {
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
                !manifestAccepted &&
                owned?.state === "active" &&
                owned.turnClaim?.claimId === reclaimClaim.claimId &&
                reclaimClaim.owner.kind === "worker" &&
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
              hasWorkerWorkspaceResultRef({ root: localPath, stagedResultRef: reclaimResultRef }),
              hasWorkerWorkspaceResultRef({
                root: localPath,
                stagedResultRef: preparedWorkerWorkspaceResultRef(reclaimResultRef),
              }),
            ]);
            // Recheck after filesystem I/O while the session barrier and workspace
            // owner lock are still held. A committed manifest or durable ref keeps
            // recovery authoritative.
            if (!canonicalExists && !preparedExists && stillOwnsEmptyResult()) {
              placements.cancelWorkspaceResultAndReleaseTurn(reclaimClaim);
            }
          });
        };
        const finishReclaim = async (): Promise<WorkerReclaimedPlacement> => {
          const pending = journal.load();
          if (pending) {
            await recoverWorkerWorkspaceReconciliation({ root: localPath, journal: pending });
            journal.abort();
          }
          const tunnel = await environments.startTunnel({
            environmentId: current.environmentId,
            ownerEpoch: current.activeOwnerEpoch,
          });
          const reclaimed = await options.workspaceOperations.run(
            current.environmentId,
            async () => {
              const owned = placements.get(current.sessionId);
              if (
                owned?.state !== "active" ||
                owned.generation !== current.generation ||
                owned.environmentId !== current.environmentId ||
                owned.activeOwnerEpoch !== current.activeOwnerEpoch ||
                owned.turnClaim?.claimId !== reclaimClaim.claimId
              ) {
                throw new Error("Cloud worker stop lost its placement owner before reconciliation");
              }
              const quiescence = await tunnel.quiesceWorkspace(current.remoteWorkspaceDir);
              let destroyed = false;
              try {
                const reconciliation = await tunnel.reconcileWorkspace({
                  localPath,
                  remoteWorkspaceDir: current.remoteWorkspaceDir,
                  baseManifestRef: current.workspaceBaseManifestRef,
                  journal,
                  stagedResult: {
                    ref: reclaimResultRef,
                    record: (ref) => placements.recordStagedWorkspaceResult(reclaimClaim, ref),
                  },
                });
                const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
                if (reconciliation.changed && !manifestAccepted) {
                  throw new Error("Cloud worker stop did not commit its reconciled workspace");
                }
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
                const priorWorkspaceResultConflict =
                  current.workspaceResultConflict ??
                  (await options.resolveWorkspaceResultConflict({
                    sessionId: current.sessionId,
                    sessionKey: current.sessionKey,
                    agentId: current.agentId,
                  }));
                const retainedWorkspaceResultConflict =
                  !reconciliation.changed && conflictPaths.length === 0
                    ? priorWorkspaceResultConflict
                    : undefined;
                const supersededConflict =
                  priorWorkspaceResultConflict &&
                  !retainedWorkspaceResultConflict &&
                  (conflictPaths.length === 0 ||
                    priorWorkspaceResultConflict.stagedResultRef !== recordedStagedResultRef)
                    ? priorWorkspaceResultConflict
                    : undefined;
                if (
                  supersededConflict &&
                  supersededConflict.stagedResultRef !== recordedStagedResultRef
                ) {
                  await deleteStagedWorkerWorkspaceResult({
                    root: localPath,
                    stagedResultRef: supersededConflict.stagedResultRef,
                  });
                }
                if (conflictPaths.length > 0 && recordedStagedResultRef) {
                  const projectedConflict = projectWorkspaceResultConflict(
                    conflictPaths,
                    recordedStagedResultRef,
                  );
                  placements.recordWorkspaceResultConflict(reclaimClaim, projectedConflict);
                  await options.reportWorkspaceResultConflict({
                    sessionId: current.sessionId,
                    sessionKey: current.sessionKey,
                    agentId: current.agentId,
                    ...projectedConflict,
                  });
                } else if (retainedWorkspaceResultConflict) {
                  // Stopping an unchanged worker is not a later cloud result. Keep the
                  // already resolved keep-local fence inspectable after placement teardown.
                  placements.recordWorkspaceResultConflict(
                    reclaimClaim,
                    retainedWorkspaceResultConflict,
                  );
                } else if (supersededConflict) {
                  placements.recordWorkspaceResultConflict(reclaimClaim, undefined);
                  await options.reportWorkspaceResultConflict({
                    sessionId: current.sessionId,
                    sessionKey: current.sessionKey,
                    agentId: current.agentId,
                    cleared: true,
                  });
                }
                const cleanupRef =
                  recordedStagedResultRef && conflictPaths.length === 0
                    ? await moveStagedWorkerWorkspaceResultToCleanup({
                        root: localPath,
                        stagedResultRef: recordedStagedResultRef,
                      })
                    : undefined;
                await environments.destroy(current.environmentId);
                destroyed = true;
                const completed = placements.completeWorkspaceResultAndReleaseTurn(reclaimClaim, {
                  reclaim: true,
                });
                if (completed.state !== "reclaimed") {
                  throw new Error("Cloud worker stop did not produce a reclaimed placement");
                }
                if (cleanupRef) {
                  await deleteStagedWorkerWorkspaceResult({
                    root: localPath,
                    stagedResultRef: cleanupRef,
                  }).catch(() => undefined);
                }
                return completed;
              } finally {
                if (!destroyed) {
                  await quiescence.resume();
                }
              }
            },
          );
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
          await cancelEmptyFailedReclaim().catch(() => undefined);
          throw error;
        }
      },
    });

  const reclaimInFlight = new Map<string, Promise<WorkerReclaimedPlacement>>();
  const reclaim = async (
    request: WorkerPlacementReclaimRequest,
  ): Promise<WorkerReclaimedPlacement> => {
    const current = placements.get(request.sessionId);
    if (current?.state === "reclaimed") {
      return current;
    }
    const inFlight = reclaimInFlight.get(request.sessionId);
    if (inFlight) {
      return await inFlight;
    }
    const operation = reclaimOnce(request);
    reclaimInFlight.set(request.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (reclaimInFlight.get(request.sessionId) === operation) {
        reclaimInFlight.delete(request.sessionId);
      }
    }
  };

  return {
    dispatch,
    forceDestroyEnvironment: (environmentId: string) =>
      options.workspaceOperations.run(environmentId, async () => {
        await forceAbandonWorkerEnvironment({
          placements,
          environmentId,
          resolveWorkspacePath: options.resolveWorkspacePath,
        });
        return await environments.destroy(environmentId);
      }),
    reclaim,
    reconcile: recovery.reconcile,
    reconcileActive: recovery.reconcileActive,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
