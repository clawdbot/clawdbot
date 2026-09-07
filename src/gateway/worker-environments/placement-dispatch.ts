import { getRuntimeConfig } from "../../config/config.js";
import { resolveNodeCommandAllowlist } from "../node-command-policy.js";
import {
  createPlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { PlacementRecoveryDeps } from "./placement-dispatch-pending-results.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import {
  createWorkerPlacementDispatchStartup,
  type WorkerDevicePlacementRequirementResolver,
  type WorkerNodePlacementAuthority,
  type WorkerPlacementRecoveryBarrier,
} from "./placement-dispatch-startup.js";
import { createWorkerPlacementMoveAbandonment } from "./placement-move-abandon.js";
import {
  createWorkerPlacementMoveService,
  type WorkerPlacementMoveBarrier,
} from "./placement-move-service.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import {
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
  type WorkerPlacementReclaimBarriers,
  type WorkerPlacementPendingOperations,
  type WorkerReclaimPlacement,
} from "./placement-reclaim-contract.js";
import {
  createWorkerPlacementReclaim,
  type WorkerPlacementReclaimOptions,
} from "./placement-reclaim.js";
import { reportPlacementTransition } from "./placement-record.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementMoveDestination,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

type WorkerLocalDispatchBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  authorize?: WorkerPlacementAuthorization;
  signal?: AbortSignal;
  startDispatch: () => WorkerDispatchPlacement;
}) => Promise<WorkerDispatchPlacement>;

type WorkerPlacementDispatchOptions = WorkerPlacementReclaimBarriers &
  WorkerPlacementReclaimOptions &
  Pick<
    PlacementRecoveryDeps,
    | "resolveWorkspace"
    | "reportWorkspaceResultRecoveryFailure"
    | "prepareAcceptedWorkspacePublication"
    | "publishAcceptedWorkspace"
  > & {
    environments: WorkerDispatchEnvironmentService &
      Pick<WorkerEnvironmentService, "recordError" | "requestDestroy"> &
      Partial<Pick<WorkerEnvironmentService, "requiresNodeEnrollment">>;
    isShuttingDown?: () => boolean;
    runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
    runLocalBarrier: WorkerLocalDispatchBarrier;
    runRecoveryBarrier: WorkerPlacementRecoveryBarrier;
    runActivationBarrier: WorkerActivationBarrier;
    runMoveBarrier: WorkerPlacementMoveBarrier;
    resolveMoveDestination: (
      identity: Pick<WorkerPlacementMoveRequest, "sessionId" | "sessionKey" | "agentId">,
      target: WorkerPlacementMoveRequest["target"],
    ) => Promise<WorkerPlacementMoveDestination | undefined>;
    onActivated?: (request: WorkerPlacementDispatchRequest) => void;
    resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
    resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
    isCurrentNodePlacement?: WorkerNodePlacementAuthority;
  };

export function createWorkerPlacementDispatchService(options: WorkerPlacementDispatchOptions) {
  const { environments, placements } = options;
  const failure = createPlacementFailureActions({ environments, placements });

  const startup = createWorkerPlacementDispatchStartup({
    ...options,
    failure,
    reportTransition: reportPlacementTransition,
  });

  // Background recovery observes previously requested cleanup; explicit Stop and
  // Move retain their retry contract. Pending-result recovery must inherit this too.
  const recoveryEnvironments = { ...environments, destroy: environments.requestDestroy };
  const recovery = createPlacementRecoveryActions({
    ...options,
    environments: recoveryEnvironments,
    failure: createPlacementFailureActions({ environments: recoveryEnvironments, placements }),
    recoverPlacementMoves: (environmentId) => moveService.recoverAll(environmentId),
  });

  const dispatch = async (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkerActiveDispatchPlacement> => {
    const assertCurrent = signal
      ? () => {
          signal.throwIfAborted();
          authorize?.();
        }
      : authorize;
    let placement: WorkerDispatchPlacement | undefined;
    try {
      signal?.throwIfAborted();
      placement = await options.runLocalBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
        authorize: assertCurrent,
        signal,
        startDispatch: () => {
          placement = placements.startDispatch({
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            executionMode: request.executionMode,
          });
          reportPlacementTransition(onTransition, placement);
          return placement;
        },
      });
      if (
        !request.deviceId &&
        request.devicePlacement?.requiredNodeCommands.length &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        )
      ) {
        const allowlist = resolveNodeCommandAllowlist(getRuntimeConfig());
        const deniedCommand = request.devicePlacement.requiredNodeCommands.find(
          (command) => !allowlist.has(command),
        );
        if (deniedCommand) {
          throw new Error(
            `cloud worker node command ${deniedCommand} is not enabled; add it to gateway.nodes.commands.allow and approve the command on the node`,
          );
        }
      }
      await startup.validateDevicePlacement(request);
      signal?.throwIfAborted();
      const workspace = await options.resolveWorkspace(request);
      if (
        workspace.kind === "repository" &&
        !request.deviceId &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        ) !== true
      ) {
        throw new Error(
          "Repository cloud sessions require a managed-node cloud provider or paired node. Choose one and retry dispatch.",
        );
      }
      const projectPath = workspace.kind === "local" ? workspace.path : undefined;
      // Workspace preparation yields; fence the current paired node again before durable provision.
      await startup.validateDevicePlacement(request);
      assertCurrent?.();
      const idempotencyKey =
        request.idempotencyKey ?? `session-dispatch:${request.sessionId}:${placement.generation}`;
      const expectedEnvironmentId = deriveEnvironmentIntent(idempotencyKey).environmentId;
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: expectedEnvironmentId },
      });
      reportPlacementTransition(onTransition, placement);
      const environment = request.inheritedProfile
        ? await environments.createFromProfileSnapshot(
            {
              profileId: request.profileId,
              providerId: request.inheritedProfile.providerId,
              profileSnapshot: request.inheritedProfile.profileSnapshot,
            },
            idempotencyKey,
            request.machineClass,
            request.executionMode,
            projectPath,
            signal,
          )
        : await environments.create(
            request.profileId,
            idempotencyKey,
            request.machineClass,
            request.executionMode,
            projectPath,
            signal,
          );
      return await startup.continueProvisionedDispatch({
        request,
        placement,
        environment,
        expectedEnvironmentId,
        workspace,
        onTransition,
        authorize: assertCurrent,
        signal,
      });
    } catch (error) {
      try {
        if (placement && startup.retainInterruptedProvisioning(placement, error)) {
          throw error;
        }
        const current = placement ? placements.get(request.sessionId) : undefined;
        if (current && current.state !== "local" && current.state !== "reclaimed") {
          if (current.state === "active") {
            await failure.failActive(current, error);
          } else {
            const currentEnvironment = current.environmentId
              ? environments.get(current.environmentId)
              : undefined;
            const ownedEnvironment =
              currentEnvironment?.environmentId === current.environmentId
                ? currentEnvironment
                : undefined;
            await failure.teardownEnvironment({
              placement: current,
              environmentId: ownedEnvironment?.environmentId ?? null,
              ownerEpoch: ownedEnvironment?.ownerEpoch ?? null,
              primaryError: error,
            });
          }
        }
      } finally {
        const finalPlacement = placements.get(request.sessionId);
        if (finalPlacement) {
          reportPlacementTransition(onTransition, finalPlacement);
        }
      }
      throw error;
    }
  };

  const reclaimOnce = createWorkerPlacementReclaim(options);

  const reclaimCurrent = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementAuthorization,
    initial?: WorkerDispatchPlacement,
    completedOperation?: WorkerPlacementCancellationTarget,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> => {
    authorize?.();
    beforeDrain?.();
    const current = placements.get(request.sessionId);
    if (current?.state === "reclaimed") {
      return current;
    }
    // Only a captured operation's successful result makes local an idempotent Stop.
    // Its real cleanup has settled, and the lifecycle and exact tuple still match.
    if (current?.state === "local" && matchesWorkerPlacementTarget(current, completedOperation)) {
      return current;
    }
    try {
      // The preparation/placement wait can span another completed failed cleanup.
      // Its old generation classifies an idempotent result, never authorizes new teardown.
      const owned = current?.state === "local" && initial?.state === "failed" ? initial : current;
      if (owned?.state === "failed" || owned?.state === "provisioning") {
        return await options.runFailedReclaimBarrier({
          ...request,
          authorize,
          reclaim: async (reauthorize) => {
            let failedPlacement = placements.get(request.sessionId);
            if (owned.state === "provisioning") {
              failedPlacement = failure.cancelProvisioning(failedPlacement, initial);
              reportPlacementTransition(onTransition, failedPlacement);
            }
            // A preceding cleanup can finish while this request waits for the lifecycle fence.
            if (
              failedPlacement?.state === "local" &&
              owned.state === "failed" &&
              failedPlacement.generation === owned.generation + 1 &&
              failedPlacement.sessionKey === request.sessionKey &&
              failedPlacement.agentId === request.agentId
            ) {
              return failedPlacement;
            }
            if (failedPlacement?.state !== "failed") {
              throw new Error("Failed cloud worker placement changed during reclaim");
            }
            const cleanupError = await failure.retryFailedTeardown(failedPlacement, reauthorize);
            const failed = placements.get(request.sessionId);
            if (failed?.state !== "failed") {
              throw new Error("Failed cloud worker placement changed during reclaim");
            }
            if (
              !isFailedWorkerPlacementEnvironmentGone({
                environmentService: environments,
                placement: failed,
              })
            ) {
              throw new Error(
                cleanupError ?? "Failed cloud worker environment cleanup is still pending",
              );
            }
            const local = placements.transition({
              sessionId: request.sessionId,
              from: "failed",
              to: "local",
              expectedGeneration: failed.generation,
            });
            if (local.state !== "local") {
              throw new Error("Failed cloud worker reclaim did not produce a local placement");
            }
            reportPlacementTransition(onTransition, local);
            return local;
          },
        });
      }
      return await reclaimOnce(request, undefined, authorize, beforeDrain, onTransition);
    } catch (error) {
      // Another teardown path can win after this call has crossed its durable completion fence.
      // Report the committed terminal state instead of leaking a stale tunnel error to callers.
      const completed = placements.get(request.sessionId);
      if (error instanceof WorkerTunnelOwnerDisconnectedError && completed?.state === "reclaimed") {
        return completed;
      }
      throw error;
    }
  };

  const reclaim = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementAuthorization,
    serialize: (
      run: () => Promise<WorkerReclaimPlacement>,
    ) => Promise<WorkerReclaimPlacement> = async (run) => await run(),
    pendingOperations?: WorkerPlacementPendingOperations,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> => {
    const initial = placements.get(request.sessionId);
    if (initial) {
      reportPlacementTransition(onTransition, initial);
    }
    return await options.runReclaimPreparation({
      ...request,
      authorize,
      beforeDrain,
      pendingOperations,
      run: (reauthorize) =>
        serialize(() =>
          reclaimCurrent(
            request,
            reauthorize,
            beforeDrain,
            initial,
            pendingOperations?.completedPlacement(),
            onTransition,
          ),
        ),
    });
  };

  const abandonment = createWorkerPlacementMoveAbandonment(options);

  const moveService = createWorkerPlacementMoveService({
    placements,
    environments,
    runMoveBarrier: options.runMoveBarrier,
    dispatch,
    reclaimSource: (request, intent, authorize, onTransition) =>
      reclaimOnce(request, intent, authorize, undefined, onTransition),
    validateAbandonSource: abandonment.validateAbandonSource,
    abandonSource: abandonment.abandonSource,
    resolveDestination: options.resolveMoveDestination,
    prepareGatewayMove: options.prepareGatewayMove,
  });

  return {
    dispatch,
    forceDestroyEnvironment: abandonment.forceDestroyEnvironment,
    move: moveService.move,
    reclaim,
    reconcile: recovery.reconcile,
    reconcileActive: recovery.reconcileActive,
    resumeProvisioning: startup.resumeProvisioning,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
