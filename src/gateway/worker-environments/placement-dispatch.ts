import {
  createPlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import { type WorkerEnvironmentService, workerEnvironmentIdForIdempotencyKey } from "./service.js";

type WorkerLocalDispatchBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  startDispatch: () => WorkerDispatchPlacement;
}) => Promise<WorkerDispatchPlacement>;

type WorkerPlacementDispatchOptions = {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runLocalBarrier: WorkerLocalDispatchBarrier;
  runActivationBarrier: WorkerActivationBarrier;
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

  return {
    dispatch,
    reconcile: recovery.reconcile,
    reconcileActive: recovery.reconcileActive,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
