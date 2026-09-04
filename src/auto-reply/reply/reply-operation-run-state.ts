import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.js";

type ReplyOperationAdmissionSnapshot =
  | { status: "owned" }
  | { status: "accepted"; mode: "steer" | "followup" }
  | {
      status: "skipped";
      reason:
        | "active-run"
        | "aborted"
        | "lifecycle-invalidated"
        | "queue-cap"
        | "question-response-indeterminate"
        | "question-response-refused";
    };

export type ReplyOperationRunState = {
  admission?: ReplyOperationAdmissionSnapshot;
  messageInjectionAborted?: true;
  agentTurn?: "ok" | "failed" | "cancelled";
  agentTurnOwner?: ReplyOperation;
};

// Carries this invocation's admission decision through reply option spreads so
// heartbeat cleanup never infers it from whichever operation is active later.
export const REPLY_OPERATION_RUN_STATE = Symbol("openclaw.replyOperationRunState");

export type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
};

export function resolveReplyOperationRunState(
  options: object | undefined,
): ReplyOperationRunState | undefined {
  return (options as ReplyOptionsWithOperationRunState | undefined)?.[REPLY_OPERATION_RUN_STATE];
}

export function recordReplyOperationAgentTurn(
  states: readonly ReplyOperationRunState[] | undefined,
  owner: ReplyOperation | undefined,
  outcome?: { kind: "aborted" | "rejected" } | { kind: "settled"; status: "ok" | "failed" },
): void {
  for (const state of states ?? []) {
    state.agentTurn =
      outcome?.kind === "aborted" || (!outcome && owner?.result?.kind === "aborted")
        ? "cancelled"
        : outcome?.kind === "settled"
          ? outcome.status
          : "failed";
    state.agentTurnOwner = owner;
  }
}

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}
