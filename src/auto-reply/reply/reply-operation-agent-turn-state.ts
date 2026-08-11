import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";

type ReplyOperationAgentTurnStatus = "ok" | "failed" | "cancelled";

const agentTurns = new WeakMap<ReplyOperationRunState, ReplyOperationAgentTurnStatus>();

export function recordReplyOperationAgentTurn(
  state: ReplyOperationRunState | undefined,
  status: ReplyOperationAgentTurnStatus,
): void {
  if (state) {
    agentTurns.set(state, status);
  }
}

export function recordReplyOperationAgentTurnOutcome(
  state: ReplyOperationRunState | undefined,
  outcome: AgentTurnExecutionResult["outcome"],
): void {
  const status =
    outcome.kind === "aborted" || (outcome.kind === "settled" && outcome.abortReason)
      ? "cancelled"
      : outcome.kind === "settled"
        ? outcome.status
        : "failed";
  recordReplyOperationAgentTurn(state, status);
}

export function resolveReplyOperationAgentTurn(
  state: ReplyOperationRunState | undefined,
): ReplyOperationAgentTurnStatus | undefined {
  return state ? agentTurns.get(state) : undefined;
}
