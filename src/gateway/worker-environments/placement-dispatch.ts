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
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";

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
        let accepted: Extract<WorkerDispatchPlacement, { state: "active" }> | undefined;
        const journal = {
          load: () => placements.loadWorkspaceReconciliation(journalOwner),
          begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
            placements.beginWorkspaceReconciliation(journalOwner, next),
          commit: (manifestRef: string) => {
            const next = placements.acceptIdleWorkspaceReconciliation({
              sessionId: current.sessionId,
              environmentId: current.environmentId,
              ownerEpoch: current.activeOwnerEpoch,
              expectedGeneration: current.generation,
              manifestRef,
            });
            if (next.state !== "active") {
              throw new Error("Cloud worker stop did not accept its reconciled workspace");
            }
            accepted = next;
          },
          abort: () => placements.abortWorkspaceReconciliation(journalOwner),
        };
        const pending = journal.load();
        if (pending) {
          await recoverWorkerWorkspaceReconciliation({ root: localPath, journal: pending });
          journal.abort();
        }
        const tunnel = await environments.startTunnel({
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
        });
        const acceptedPlacement = await options.workspaceOperations.run(
          current.environmentId,
          async () => {
            const owned = placements.get(current.sessionId);
            if (
              owned?.state !== "active" ||
              owned.generation !== current.generation ||
              owned.environmentId !== current.environmentId ||
              owned.activeOwnerEpoch !== current.activeOwnerEpoch ||
              owned.turnClaim
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
              });
              if (!accepted) {
                throw new Error("Cloud worker stop did not commit its reconciled workspace");
              }
              await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
              await environments.destroy(current.environmentId);
              destroyed = true;
              return accepted;
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
        // Provider teardown is proven. Persist the terminal placement state in
        // one CAS so restart recovery never strands a successful stop mid-transition.
        const reclaimed = placements.finishReclaim({
          sessionId: acceptedPlacement.sessionId,
          environmentId: acceptedPlacement.environmentId,
          ownerEpoch: acceptedPlacement.activeOwnerEpoch,
          expectedGeneration: acceptedPlacement.generation,
        });
        if (reclaimed.state !== "reclaimed") {
          throw new Error("Cloud worker stop did not produce a reclaimed placement");
        }
        return reclaimed;
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
