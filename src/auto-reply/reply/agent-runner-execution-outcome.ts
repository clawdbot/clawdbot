import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { recordMessageToolRunOutcome } from "../../infra/message-tool-run-outcome-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";

const messageToolOutcomeLog = createSubsystemLogger("auto-reply/message-tool-outcome");

export function recordAgentTurnExecutionOutcome(
  params: AgentTurnParams,
  result: AgentTurnExecutionResult | undefined,
): void {
  const executionStatus = resolveAgentTurnExecutionStatus(result?.outcome);
  if (executionStatus !== "cancelled") {
    params.opts?.onAgentRunTerminalOutcome?.(executionStatus === "ok" ? "completed" : "failed");
  }
  const sourceReplyDeliveryMode =
    params.followupRun.run.sourceReplyDeliveryMode ?? params.opts?.sourceReplyDeliveryMode;
  if (sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  const sessionKey = params.sessionKey ?? params.followupRun.run.sessionKey;
  if (!sessionKey) {
    messageToolOutcomeLog.warn("message-tool-only run outcome missing session key", {
      runId: result?.runId ?? params.opts?.runId,
      agentId: params.followupRun.run.agentId,
    });
    return;
  }
  const outcome = result?.outcome;
  const resolved =
    outcome?.kind === "settled" || outcome?.kind === "rejected" ? outcome.resolved : undefined;
  const runStatus: "completed" | "errored" | "aborted" =
    executionStatus === "ok" ? "completed" : executionStatus === "failed" ? "errored" : "aborted";
  const toolDelivered =
    outcome?.kind === "settled" && hasCompletedSourceReplyDeliveryEvidence(outcome.result);
  const values = {
    runId: result?.runId ?? params.opts?.runId ?? "unknown",
    sessionKey,
    agentId: params.followupRun.run.agentId,
    provider: resolved?.provider ?? params.followupRun.run.provider,
    model: resolved?.model ?? params.followupRun.run.model,
    outcome: toolDelivered ? ("tool_delivered" as const) : ("mute" as const),
    runStatus,
    occurredAt: Date.now(),
    storePath: params.storePath,
  };
  try {
    recordMessageToolRunOutcome(values);
    messageToolOutcomeLog.info("recorded message-tool-only run outcome", values);
  } catch (error) {
    messageToolOutcomeLog.warn("failed to record message-tool-only run outcome", {
      ...values,
      error: formatErrorMessage(error),
    });
  }
}
