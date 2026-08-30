import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import { recordReplyOperationCompletedSourceReply } from "./reply-completion-handoff.js";

/** Returns delivery evidence while minting a fact only for a successfully settled owner run. */
export function recordSourceReplyEvidence(
  params: AgentTurnParams,
  result: AgentTurnExecutionResult | undefined,
): boolean {
  const outcome = result?.outcome;
  const toolDelivered =
    outcome?.kind === "settled" && hasCompletedSourceReplyDeliveryEvidence(outcome.result);
  if (
    toolDelivered &&
    outcome.kind === "settled" &&
    outcome.status === "ok" &&
    !outcome.abortReason &&
    params.replyOperation
  ) {
    // This runs before execution returns: owner-clear callbacks must never
    // observe a completed operation without its source-delivery fact.
    recordReplyOperationCompletedSourceReply(params.replyOperation, params.followupRun);
  }
  return toolDelivered;
}
