import type { ReplyOperationRunState } from "./reply-operation-run-state.js";

type ReplyOperationAgentTurnStatus = "ok" | "failed" | "superseded";

const agentTurns = new WeakMap<ReplyOperationRunState, ReplyOperationAgentTurnStatus>();

export function recordReplyOperationAgentTurn(
  state: ReplyOperationRunState | undefined,
  status: ReplyOperationAgentTurnStatus,
): void {
  if (state) {
    agentTurns.set(state, status);
  }
}

export function resolveReplyOperationAgentTurn(
  state: ReplyOperationRunState | undefined,
): ReplyOperationAgentTurnStatus | undefined {
  return state ? agentTurns.get(state) : undefined;
}
