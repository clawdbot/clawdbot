import type { WorkerPlacementMoveIntent } from "../worker-environments/placement-move-intent.js";
import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
} from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { GatewayRequestContext } from "./types.js";

function projectSessionPlacementFields(params: {
  context: GatewayRequestContext;
  sessionId: string | undefined;
  placements?: ReadonlyMap<string, WorkerSessionPlacementRecord>;
  moves?: ReadonlyMap<string, WorkerPlacementMoveIntent>;
}) {
  const placement = params.sessionId ? params.placements?.get(params.sessionId) : undefined;
  const move = params.sessionId ? params.moves?.get(params.sessionId) : undefined;
  return {
    ...(placement
      ? {
          placement: projectWorkerSessionPlacement(
            placement,
            params.context.workerPlacementDiskSpaceReader?.read(placement),
            params.context.workerPlacementRunnerAvailabilityReader?.read(placement),
          ),
        }
      : {}),
    ...(move ? { placementMove: projectWorkerPlacementMove(move) } : {}),
  };
}

export function createSessionPlacementBatchProjector(
  context: GatewayRequestContext,
  sessions: readonly { sessionId?: string }[],
) {
  const sessionIds = sessions.flatMap((session) => (session.sessionId ? [session.sessionId] : []));
  const placements = context.workerSessionPlacementService?.getMany(sessionIds);
  const moves = context.workerSessionPlacementService?.getPlacementMoves?.(sessionIds);
  return (sessionId: string | undefined) =>
    projectSessionPlacementFields({ context, sessionId, placements, moves });
}

export function readSessionPlacementFields(
  context: GatewayRequestContext,
  sessionId: string | undefined,
) {
  return createSessionPlacementBatchProjector(
    context,
    sessionId ? [{ sessionId }] : [{}],
  )(sessionId);
}
