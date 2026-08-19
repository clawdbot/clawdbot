import type {
  WorkerActiveDispatchPlacement,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import type {
  WorkerPlacementMoveIntent,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementMoveDestination,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";

type WorkerDrainingDispatchPlacement = Extract<WorkerDispatchPlacement, { state: "draining" }>;
type WorkerMovePlacement = Extract<WorkerDispatchPlacement, { state: "local" | "active" }>;
type WorkerReclaimPlacement = Extract<WorkerDispatchPlacement, { state: "local" | "reclaimed" }>;
const RESTART_AUTHORITY_EXPIRED =
  "Cloud worker move request authority expired after Gateway restart; retry move";

export type WorkerPlacementMoveBarrier = (
  params: MoveSessionIdentity & {
    authorize?: WorkerPlacementAuthorization;
    begin: () => {
      intent: WorkerPlacementMoveIntent;
      placement: WorkerDrainingDispatchPlacement;
      joined: boolean;
    };
  },
) => Promise<{
  intent: WorkerPlacementMoveIntent;
  placement: WorkerDrainingDispatchPlacement;
  joined: boolean;
}>;

type MoveSessionIdentity = Pick<WorkerPlacementMoveRequest, "sessionId" | "sessionKey" | "agentId">;

export function createWorkerPlacementMoveService(options: {
  placements: WorkerDispatchPlacementStore;
  environments: Pick<WorkerDispatchEnvironmentService, "get">;
  runMoveBarrier: WorkerPlacementMoveBarrier;
  dispatch: (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
  ) => Promise<WorkerActiveDispatchPlacement>;
  reclaimSource: (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
  ) => Promise<WorkerReclaimPlacement>;
  resolveDestination: (
    identity: MoveSessionIdentity,
    target: WorkerPlacementMoveTarget,
  ) => Promise<WorkerPlacementMoveDestination | undefined>;
}) {
  const recordError = (intent: WorkerPlacementMoveIntent, error: unknown): void => {
    options.placements.recordPlacementMoveError({
      operationId: intent.operationId,
      sessionId: intent.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const finishWorkerDestination = async (params: {
    identity: MoveSessionIdentity;
    intent: WorkerPlacementMoveIntent;
    destination: NonNullable<WorkerPlacementMoveDestination>;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
  }): Promise<WorkerActiveDispatchPlacement> => {
    const active = await options.dispatch(
      {
        ...params.identity,
        ...params.destination,
        idempotencyKey: `session-move:${params.intent.operationId}:dispatch`,
      },
      params.onTransition,
      params.authorize,
    );
    const completed = options.placements.completePlacementMoveToWorker({
      operationId: params.intent.operationId,
      sessionId: params.identity.sessionId,
      expectedGeneration: active.generation,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    if (completed.state !== "active") {
      throw new Error(`Session ${params.identity.sessionKey} move did not finish active`);
    }
    return completed;
  };

  const move = async (
    request: WorkerPlacementMoveRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<WorkerMovePlacement> => {
    let intent: WorkerPlacementMoveIntent | undefined;
    try {
      const destination =
        request.target.kind === "gateway"
          ? undefined
          : await options.resolveDestination(request, request.target);
      if (request.target.kind !== "gateway" && !destination) {
        throw new Error(`Session ${request.sessionKey} worker move target is unavailable`);
      }
      const begun = await options.runMoveBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        authorize,
        begin: () => {
          const started = options.placements.beginPlacementMove({
            sessionId: request.sessionId,
            source: request.source,
            target: request.target,
          });
          if (started.placement.state !== "draining") {
            throw new Error(
              `Session ${request.sessionKey} placement move is already in ${started.placement.state}`,
            );
          }
          return { ...started, placement: started.placement };
        },
      });
      intent = begun.intent;
      onTransition?.(begun.placement);
      const local = await options.reclaimSource(request, intent, authorize);
      onTransition?.(local);
      if (local.state !== "local") {
        throw new Error(`Session ${request.sessionKey} move did not return to local placement`);
      }
      if (request.target.kind === "gateway") {
        return local;
      }
      if (!destination) {
        throw new Error(`Session ${request.sessionKey} worker move target is unavailable`);
      }
      return await finishWorkerDestination({
        identity: request,
        intent,
        destination,
        ...(onTransition ? { onTransition } : {}),
        ...(authorize ? { authorize } : {}),
      });
    } catch (error) {
      const durableIntent = intent ?? options.placements.getPlacementMove(request.sessionId);
      if (durableIntent) {
        recordError(durableIntent, error);
      }
      throw error;
    }
  };

  const recover = async (intent: WorkerPlacementMoveIntent): Promise<void> => {
    try {
      let placement = options.placements.get(intent.sessionId);
      if (!placement) {
        throw new Error(`Session ${intent.sessionId} placement move lost its session placement`);
      }
      const identity = {
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
      };
      if (placement.state === "failed") {
        if (
          !isFailedWorkerPlacementEnvironmentGone({
            environmentService: options.environments,
            placement,
          })
        ) {
          throw new Error(
            `Session ${identity.sessionKey} failed move environment must finish teardown before retry`,
          );
        }
        options.placements.cancelPlacementMove({
          operationId: intent.operationId,
          sessionId: intent.sessionId,
        });
        return;
      } else if (placement.state === "draining") {
        const local = await options.reclaimSource(identity, intent);
        if (local.state !== "local") {
          throw new Error(`Session ${identity.sessionKey} move recovery did not return local`);
        }
        placement = local;
      } else if (placement.state === "reconciling") {
        const environment = options.environments.get(placement.environmentId);
        if (
          environment &&
          environment.state !== "destroyed" &&
          environment.state !== "failed" &&
          environment.state !== "orphaned"
        ) {
          return;
        }
        placement = options.placements.completePlacementMoveSourceToLocal({
          operationId: intent.operationId,
          sessionId: intent.sessionId,
          expectedGeneration: placement.generation,
        });
      } else if (placement.state === "active") {
        const stillSource =
          placement.environmentId === intent.source.environmentId &&
          placement.activeOwnerEpoch === intent.source.ownerEpoch;
        if (stillSource) {
          throw new Error(`Session ${identity.sessionKey} move recovery found an active source`);
        }
        options.placements.completePlacementMoveToWorker({
          operationId: intent.operationId,
          sessionId: intent.sessionId,
          expectedGeneration: placement.generation,
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        return;
      } else if (placement.state !== "local") {
        // Generic dispatch recovery owns requested through starting. A later
        // coordinated sweep either observes active or retries from failed/local.
        return;
      }
      if (intent.target.kind === "gateway") {
        if (options.placements.getPlacementMove(intent.sessionId)) {
          options.placements.cancelPlacementMove({
            operationId: intent.operationId,
            sessionId: intent.sessionId,
          });
        }
        return;
      }
      options.placements.fail({
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        recoveryError: RESTART_AUTHORITY_EXPIRED,
      });
      options.placements.cancelPlacementMove({
        operationId: intent.operationId,
        sessionId: intent.sessionId,
      });
    } catch (error) {
      recordError(intent, error);
      throw error;
    }
  };

  const recoverAll = async (): Promise<Set<string>> => {
    const protectedSessions = new Set<string>();
    for (const intent of options.placements.listPlacementMoves()) {
      const state = options.placements.get(intent.sessionId)?.state;
      if (state === "draining" || state === "reconciling") {
        protectedSessions.add(intent.sessionId);
      }
      await recover(intent).catch(() => undefined);
    }
    return protectedSessions;
  };

  return { move, recoverAll };
}
