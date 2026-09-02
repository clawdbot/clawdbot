// Gateway RPC handler for the read-only task-lane snapshot (taskLanes.list).

import {
  validateTaskLaneListParams,
  type TaskLaneListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const taskLanesHandlers: GatewayRequestHandlers = {
  "taskLanes.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTaskLaneListParams, "taskLanes.list", respond)) {
      return;
    }
    // SAFETY: validated against TaskLaneListParamsSchema above.
    const p = params as TaskLaneListParams;
    const snapshot = await context.taskLanes.snapshot({
      providerId: p.providerId,
      limit: p.limit,
      offset: p.offset,
    });
    respond(true, snapshot, undefined);
  },
};
