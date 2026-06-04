// Resolves queue mode and admission policy for a reply turn.
import type { QueueSettings } from "./queue.js";

/** Queue decisions for messages that arrive while an agent run is active. */
export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

/** Resolves whether an active session should run, queue, or drop a new inbound turn. */
export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
  resetTriggered?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  if (params.resetTriggered) {
    return "run-now";
  }
  // Follow-up queueing is only meaningful for non-heartbeat user turns.
  if (params.shouldFollowup) {
    return "enqueue-followup";
  }
  return "run-now";
}
