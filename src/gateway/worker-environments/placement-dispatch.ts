import { randomUUID } from "node:crypto";
import { supportsWorkerExecutionContextLaunch } from "./admission.js";
import * as device from "./device-provider.js";
import {
  createPlacementFailureActions,
  isUnavailableEnvironment,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import { placementTurnOwner } from "./placement-record.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";
import {
  findWorkerWorkspaceOperatorRecoveryError,
  WorkerTunnelOwnerDisconnectedError,
} from "./tunnel-contract.js";
import type { WorkerWorkspaceResultConflict } from "./workspace-conflicts.js";
import {
  verifyReconciledWorkspaceFinal,
  WorkerWorkspaceFinalFenceError,
} from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
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

type WorkerLocalDispatchBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  startDispatch: () => WorkerDispatchPlacement;
}) => Promise<WorkerDispatchPlacement>;

type WorkerReclaimedPlacement = Extract<WorkerDispatchPlacement, { state: "reclaimed" }>;
type WorkerReclaimPlacement = Extract<WorkerDispatchPlacement, { state: "local" | "reclaimed" }>;
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
  onActivated?: (request: WorkerPlacementDispatchRequest) => void;
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
  // Node vs SSH transport is decided later from the environment itself; both
  // arms of the old discriminated return carried identical fields, so this
  // only validates dispatchability and hands back the prepared facts.
  if (
    (environment.state !== "ready" && environment.state !== "idle") ||
    environment.environmentId !== expectedEnvironmentId ||
    !environment.bootstrapReceipt ||
    !supportsWorkerExecutionContextLaunch(environment.bootstrapReceipt)
  ) {
    throw new Error(
      `Worker environment is not dispatchable with the current execution-context contract: ${environment.state}`,
    );
  }
  return {
    environmentId: environment.environmentId,
    ownerEpoch: environment.ownerEpoch,
    bundleHash: environment.bootstrapReceipt.bundleHash,
  };
}

function isExactAttachedEnvironment(
  environment: ReturnType<WorkerDispatchEnvironmentService["get"]>,
  placement: WorkerActiveDispatchPlacement,
): boolean {
  return (
    environment?.environmentId === placement.environmentId &&
    environment.state === "attached" &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === placement.sessionId
  );
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

  const reportTransition = (
    observer: ((placement: WorkerDispatchPlacement) => void) | undefined,
    placement: WorkerDispatchPlacement,
  ): void => {
    try {
      observer?.(placement);
    } catch {
      // Reporting cannot overturn the durable placement transition.
    }
  };

  const dispatch = async (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerActiveDispatchPlacement> => {
    let placement: WorkerDispatchPlacement | undefined;
    let environmentId: string | null = null;
    let ownerEpoch: number | null = null;
    try {
      placement = await options.runLocalBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
        startDispatch: () => {
          placement = placements.startDispatch({
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            executionMode: request.executionMode,
          });
          reportTransition(onTransition, placement);
          return placement;
        },
      });
      if (request.deviceId) {
        const availability = await device.resolveDeviceWorkerAvailability(
          environments,
          request.deviceId,
        );
        if (!availability.available) {
          throw new Error(device.deviceUnavailableText(request.deviceId, availability));
        }
      }
      const localPath = await options.resolveWorkspacePath(request);
      const idempotencyKey = `session-dispatch:${request.sessionId}:${placement.generation}`;
      const expectedEnvironmentId = deriveEnvironmentIntent(idempotencyKey).environmentId;
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: expectedEnvironmentId },
      });
      reportTransition(onTransition, placement);
      const environment = request.inheritedProfile
        ? await environments.createFromProfileSnapshot(
            {
              profileId: request.profileId,
              providerId: request.inheritedProfile.providerId,
              profileSnapshot: request.inheritedProfile.profileSnapshot,
            },
            idempotencyKey,
          )
        : await environments.create(request.profileId, idempotencyKey);
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
      reportTransition(onTransition, placement);
      const credential = await environments.attachSession({
        environmentId,
        ownerEpoch,
        sessionId: request.sessionId,
      });
      ownerEpoch = credential.ownerEpoch;
      const tunnel = await environments.startTunnel({ environmentId, ownerEpoch });
      const synced = await tunnel.syncWorkspace({
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
      reportTransition(onTransition, placement);
      const startingPlacement = placement;
      const activePlacement = await options.runActivationBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
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
          reportTransition(onTransition, activated);
          return activated;
        },
      });
      try {
        options.onActivated?.(request);
      } catch {
        // Maintenance scheduling cannot overturn a durable placement activation.
      }
      return activePlacement;
    } catch (error) {
      try {
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
      } finally {
        const finalPlacement = placements.get(request.sessionId);
        if (finalPlacement) {
          reportTransition(onTransition, finalPlacement);
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
        if (!isExactAttachedEnvironment(environment, current)) {
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
                owned?.state === "active" &&
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
              await placements.closeWorkerTurnToolState(reclaimClaim);
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
                const finalized = await finalizeWorkspaceResultConflicts({
                  placements,
                  turnClaim: reclaimClaim,
                  conflictPaths,
                  priorConflict: priorWorkspaceResultConflict,
                  stagedResultRef: recordedStagedResultRef,
                  // An unchanged stop is not a later cloud result; keep its prior fence inspectable.
                  retainPriorConflict: !reconciliation.changed,
                  root: localPath,
                  report: async (report) =>
                    await options.reportWorkspaceResultConflict({
                      sessionId: current.sessionId,
                      sessionKey: current.sessionKey,
                      agentId: current.agentId,
                      ...report,
                    }),
                });
                return await settleStagedWorkspaceResult({
                  placements,
                  turnClaim: reclaimClaim,
                  root: localPath,
                  stagedResultRef: recordedStagedResultRef,
                  conflictRetained: finalized.conflictRetained,
                  reclaim: true,
                  beforeComplete: async () => {
                    await environments.destroyOwned(current.environmentId, () =>
                      placements.canDestroyAcceptedWorkspaceResult(reclaimClaim),
                    );
                    destroyed = true;
                  },
                  validateCompleted: (completed) => {
                    if (completed.state !== "reclaimed") {
                      throw new Error("Cloud worker stop did not produce a reclaimed placement");
                    }
                  },
                });
              } finally {
                if (
                  !destroyed &&
                  isExactAttachedEnvironment(environments.get(current.environmentId), current)
                ) {
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
          const operatorRecoveryError = findWorkerWorkspaceOperatorRecoveryError(error);
          if (operatorRecoveryError) {
            const owned = placements.get(current.sessionId);
            const retainsReclaimResult = placements
              .listPendingWorkspaceResults()
              .some(
                (pending) =>
                  pending.sessionId === reclaimClaim.sessionId &&
                  pending.claimId === reclaimClaim.claimId &&
                  pending.runId === reclaimClaim.runId,
              );
            if (
              owned?.state === "active" &&
              owned.generation === current.generation &&
              owned.environmentId === current.environmentId &&
              owned.activeOwnerEpoch === current.activeOwnerEpoch &&
              owned.turnClaim?.claimId === reclaimClaim.claimId &&
              retainsReclaimResult
            ) {
              await failure.recordRetainedResultFailure(owned, operatorRecoveryError);
            }
            throw error;
          }
          // An unstaged final-fence failure is retryable even after an unchanged
          // manifest commit; the journal remains authoritative for the next attempt.
          await cancelUnstagedFailedReclaim(
            error instanceof WorkerWorkspaceFinalFenceError && error.reclaimDisposition === "retry",
          ).catch(() => undefined);
          throw error;
        }
      },
    });

  const reclaimInFlight = new Map<string, Promise<WorkerReclaimPlacement>>();
  const reclaim = async (
    request: WorkerPlacementReclaimRequest,
  ): Promise<WorkerReclaimPlacement> => {
    const current = placements.get(request.sessionId);
    if (current?.state === "reclaimed") {
      return current;
    }
    const inFlight = reclaimInFlight.get(request.sessionId);
    if (inFlight) {
      return await inFlight;
    }
    const operation = (async () => {
      const owned = placements.get(request.sessionId);
      if (owned?.state === "failed") {
        if (
          !isFailedWorkerPlacementEnvironmentGone({
            environmentService: environments,
            placement: owned,
          })
        ) {
          throw new Error("Failed cloud worker environment must be stopped before reclaim");
        }
        const local = placements.transition({
          sessionId: request.sessionId,
          from: "failed",
          to: "local",
          expectedGeneration: owned.generation,
        });
        if (local.state !== "local") {
          throw new Error("Failed cloud worker reclaim did not produce a local placement");
        }
        return local;
      }
      return await reclaimOnce(request);
    })().catch((error: unknown) => {
      // Another teardown path can win after this call has crossed its durable completion fence.
      // Report the committed terminal state instead of leaking a stale tunnel error to callers.
      const completed = placements.get(request.sessionId);
      if (error instanceof WorkerTunnelOwnerDisconnectedError && completed?.state === "reclaimed") {
        return completed;
      }
      throw error;
    });
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
    forceDestroyEnvironment: (environmentId: string, onCleanupError?: (error: unknown) => void) =>
      options.workspaceOperations.run(environmentId, async () => {
        await forceAbandonWorkerEnvironment({
          placements,
          environmentId,
          resolveWorkspacePath: options.resolveWorkspacePath,
          onCleanupError,
        });
        try {
          return await environments.destroyOwned(environmentId, () =>
            placements.canDestroyForceAbandonedEnvironment(environmentId),
          );
        } catch (error) {
          const current = environments.get(environmentId);
          if (!current || !isUnavailableEnvironment(current)) {
            throw error;
          }
          try {
            onCleanupError?.(error);
          } catch {
            // Reporting cannot overturn the durable placement/environment fences.
          }
          return current;
        }
      }),
    reclaim,
    reconcile: recovery.reconcile,
    reconcileActive: recovery.reconcileActive,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
