import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.js";
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

// Rejection diagnostics carry owner-selected codes, never user-facing error text.
export type ReplyPreRunRejectionCode =
  | "model-scope-conflict"
  | "model-scope-not-authorized"
  | "model-selection-locked"
  | "model-runtime-invalid"
  | "model-selection-rejected"
  | "model-selection-conflict"
  | "session-directive-rejected";

export type ReplyOperationRunState = {
  heartbeat?: {
    prepareReply: (
      replyResult: ReplyPayload | ReplyPayload[] | undefined,
      runState: ReplyOperationRunState,
    ) => Promise<{
      reply?: ReplyPayload;
      settle?: (outcome: ReplyDispatchDeliveryOutcome) => Promise<void>;
    }>;
  };
  admission?: ReplyOperationAdmissionSnapshot;
  messageInjectionAborted?: true;
  agentTurn?: ReturnType<typeof resolveAgentTurnExecutionStatus>;
  agentTurnOwner?: ReplyOperation;
  preRunRejection?: ReplyPreRunRejectionCode;
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

export function recordReplyPreRunRejection(
  state: ReplyOperationRunState | undefined,
  rejection: ReplyPreRunRejectionCode | undefined,
): void {
  if (state && rejection) {
    state.preRunRejection ??= rejection;
  }
}

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}
