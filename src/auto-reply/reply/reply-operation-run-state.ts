import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
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

/**
 * Closed codes for a directive decision that answered the turn before any model
 * run started. The directive owner records the code so the dispatch terminal
 * outcome can name the rejection instead of reporting a completed turn.
 */
export type ReplyPreRunRejectionCode =
  | "model-scope-conflict"
  | "model-scope-not-authorized"
  | "model-selection-locked"
  | "model-policy-rejected"
  | "model-runtime-invalid"
  | "model-selection-rejected"
  | "model-selection-conflict"
  | "session-directive-rejected";

export type ReplyPreRunRejection = {
  code: ReplyPreRunRejectionCode;
  errorText: string;
};

export type ReplyOperationRunState = {
  admission?: ReplyOperationAdmissionSnapshot;
  messageInjectionAborted?: true;
  agentTurn?: ReturnType<typeof resolveAgentTurnExecutionStatus>;
  agentTurnOwner?: ReplyOperation;
  preRunRejection?: ReplyPreRunRejection;
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
  outcome?: Parameters<typeof resolveAgentTurnExecutionStatus>[0],
): void {
  for (const state of states ?? []) {
    state.agentTurn = resolveAgentTurnExecutionStatus(
      outcome ?? (owner?.result?.kind === "aborted" ? owner.result : undefined),
    );
    state.agentTurnOwner = owner;
  }
}

// Every pre-run rejection site shares this so the first rejecting decision owns
// the turn's diagnostic outcome and later sites never overwrite it.
export function recordReplyPreRunRejection(
  state: ReplyOperationRunState | undefined,
  rejection: ReplyPreRunRejection | undefined,
): void {
  if (state && rejection && !state.preRunRejection) {
    state.preRunRejection = rejection;
  }
}

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}
