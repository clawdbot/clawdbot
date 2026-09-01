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
import {
  matchesWorkerPlacementTarget,
  type WorkerReclaimPlacement,
} from "./placement-reclaim-contract.js";
import {
  isCurrentPlacementTurnClaim,
  projectWorkerSessionTurnClaim,
  reportPlacementTransition,
} from "./placement-record.js";
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
type WorkerPlacementMoveSourceDisposition = "reconcile" | "abandon";
const RESTART_AUTHORITY_EXPIRED =
  "Cloud worker move request authority expired after Gateway restart; retry move";

export type WorkerPlacementMoveBarrier = (
  params: MoveSessionIdentity & {
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    sourceDisposition: WorkerPlacementMoveSourceDisposition;
    begin: (prepareNew?: (runId: string) => Promise<void>) => Promise<{
      intent: WorkerPlacementMoveIntent;
      placement: WorkerDrainingDispatchPlacement;
      joined: boolean;
    }>;
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
    signal?: AbortSignal,
  ) => Promise<WorkerActiveDispatchPlacement>;
  reclaimSource: (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ) => Promise<WorkerReclaimPlacement>;
  validateAbandonSource: (request: WorkerPlacementMoveRequest) => void;
  abandonSource: (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
  ) => Promise<Extract<WorkerDispatchPlacement, { state: "local" }>>;
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

  const move = async (
    request: WorkerPlacementMoveRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkerMovePlacement> => {
    const assertCurrent = signal
      ? () => {
          signal.throwIfAborted();
          authorize?.();
        }
      : authorize;
    let intent: WorkerPlacementMoveIntent | undefined;
    let local: WorkerReclaimPlacement | undefined;
    try {
      signal?.throwIfAborted();
      if (request.abandonSource && request.target.kind !== "gateway") {
        throw new Error("Source abandonment is available only when continuing on the Gateway");
      }
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
        sourceDisposition: request.abandonSource ? "abandon" : "reconcile",
        authorize: assertCurrent,
        signal,
        begin: async (prepareNew) => {
          const moveRequest = {
            sessionId: request.sessionId,
            source: request.source,
            target: request.target,
            ...(request.abandonSource ? { abandonSource: true as const } : {}),
          };
          // Existing durable decisions own retries. Prepare only a new intent, outside
          // the synchronous commit, so both branches publish their owner before yielding.
          if (request.abandonSource && !options.placements.getPlacementMove(request.sessionId)) {
            options.validateAbandonSource(request);
            const placement = options.placements.get(request.sessionId);
            const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
            if (claim && prepareNew) {
              await prepareNew(claim.runId);
              const current = options.placements.get(request.sessionId);
              if (!current || !isCurrentPlacementTurnClaim(current, claim)) {
                throw new Error(
                  `Session ${request.sessionKey} abandonment worker turn changed; retry`,
                );
              }
              options.validateAbandonSource(request);
            }
          }
          const started = options.placements.beginPlacementMove(moveRequest);
          if (started.placement.state !== "draining") {
            throw new Error(
              `Session ${request.sessionKey} placement move is already in ${started.placement.state}`,
            );
          }
          reportPlacementTransition(onTransition, started.placement);
          return { ...started, placement: started.placement };
        },
      });
      intent = begun.intent;
      local = request.abandonSource
        ? await options.abandonSource(request, intent, assertCurrent)
        : await options.reclaimSource(request, intent, assertCurrent, onTransition);
      if (request.abandonSource) {
        reportPlacementTransition(onTransition, local);
      }
      if (local.state !== "local") {
        throw new Error(`Session ${request.sessionKey} move did not return to local placement`);
      }
      if (!destination) {
        return local;
      }
      const active = await options.dispatch(
        {
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          agentId: request.agentId,
          ...destination,
          idempotencyKey: `session-move:${intent.operationId}:dispatch`,
        },
        onTransition,
        assertCurrent,
        signal,
      );
      const completed = options.placements.completePlacementMoveToWorker({
        operationId: intent.operationId,
        sessionId: request.sessionId,
        expectedGeneration: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      if (completed.state !== "active") {
        throw new Error(`Session ${request.sessionKey} move did not finish active`);
      }
      return completed;
    } catch (error) {
      // Source cleanup is settled. A canceled, unpublished destination leaves this
      // exact local completion for Stop; unrelated errors or replacements still fail.
      if (
        intent &&
        local?.state === "local" &&
        signal?.aborted &&
        error === signal.reason &&
        matchesWorkerPlacementTarget(options.placements.get(request.sessionId), local)
      ) {
        options.placements.cancelPlacementMove({
          operationId: intent.operationId,
          sessionId: request.sessionId,
        });
        return local;
      }
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
      if (intent.abandonSource) {
        if (intent.target.kind !== "gateway") {
          throw new Error(
            `Session ${identity.sessionKey} abandonment intent has a non-Gateway target`,
          );
        }
        if (placement.state === "local") {
          options.placements.cancelPlacementMove({
            operationId: intent.operationId,
            sessionId: intent.sessionId,
          });
          return;
        }
        if (
          placement.state !== "active" &&
          placement.state !== "draining" &&
          placement.state !== "reconciling" &&
          placement.state !== "failed"
        ) {
          throw new Error(
            `Session ${identity.sessionKey} abandonment recovery is waiting in ${placement.state}`,
          );
        }
        await options.abandonSource(identity, intent);
        return;
      }
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

  const recoverAll = async (environmentId?: string): Promise<Set<string>> => {
    const protectedSessions = new Set<string>();
    for (const intent of options.placements.listPlacementMoves()) {
      const placement = options.placements.get(intent.sessionId);
      // Source cleanup can leave a local placement; destination activation keeps the
      // move intent until completion. Either owner must be able to finish that move.
      if (
        environmentId !== undefined &&
        intent.source.environmentId !== environmentId &&
        placement?.environmentId !== environmentId
      ) {
        continue;
      }
      const state = placement?.state;
      if (
        (intent.abandonSource && state !== "local") ||
        state === "draining" ||
        state === "reconciling"
      ) {
        protectedSessions.add(intent.sessionId);
      }
      await recover(intent).catch(() => undefined);
    }
    return protectedSessions;
  };

  return { move, recoverAll };
}
