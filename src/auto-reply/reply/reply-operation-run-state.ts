import type { FollowupRun } from "./queue/types.js";

type ReplyOperationAdmissionSnapshot =
  | { status: "owned" }
  | { status: "accepted"; mode: "steer" | "followup" }
  | {
      status: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated" | "queue-cap";
    };

export type ReplyOperationRunState = {
  admission?: ReplyOperationAdmissionSnapshot;
  agentTurn?: { status: "ok" | "failed" };
};

// Carries this invocation's admission and terminal agent-turn facts through
// reply option spreads so heartbeat cleanup never re-derives them from payloads.
export const REPLY_OPERATION_RUN_STATE = Symbol("openclaw.replyOperationRunState");

export type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
};

export function resolveReplyOperationRunState(
  options: object | undefined,
): ReplyOperationRunState | undefined {
  return (options as ReplyOptionsWithOperationRunState | undefined)?.[REPLY_OPERATION_RUN_STATE];
}

export function bindQueueDispositionToRunState(
  run: FollowupRun,
  state: ReplyOperationRunState | undefined,
): void {
  const observe = run.onQueueDisposition;
  run.onQueueDisposition = (disposition) => {
    observe?.(disposition);
    if (state && disposition !== "queue-cap-old") {
      state.admission = { status: "skipped", reason: "queue-cap" };
    }
  };
}
