import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";

type ReplyOperationAgentTurnStatus = "ok" | "failed" | "superseded";

type ReplyOperationAgentTurn = {
  status: ReplyOperationAgentTurnStatus;
  owner?: ReplyOperation;
};

const agentTurns = new WeakMap<ReplyOperationRunState, ReplyOperationAgentTurn>();

export function recordReplyOperationAgentTurn(
  state: ReplyOperationRunState | undefined,
  status: ReplyOperationAgentTurnStatus,
  owner?: ReplyOperation,
): void {
  if (state) {
    agentTurns.set(state, { status, owner });
  }
}

export function resolveReplyOperationAgentTurn(
  state: ReplyOperationRunState | undefined,
): ReplyOperationAgentTurnStatus | undefined {
  if (!state) {
    return undefined;
  }
  const turn = agentTurns.get(state);
  return isReplyOperationSuperseded(turn?.owner) ? "superseded" : turn?.status;
}
