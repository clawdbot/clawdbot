import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { recordMessageToolRunOutcome } from "../../infra/message-tool-run-outcome-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";

const messageToolOutcomeLog = createSubsystemLogger("auto-reply/message-tool-outcome");

export function recordMessageToolOnlyRunOutcome(
  params: AgentTurnParams,
  result: AgentTurnExecutionResult | undefined,
): void {
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
  const provider = resolved?.provider ?? params.followupRun.run.provider;
  const model = resolved?.model ?? params.followupRun.run.model;
  const runStatus: "completed" | "errored" | "aborted" =
    outcome?.kind === "aborted"
      ? "aborted"
      : !outcome || outcome.kind === "rejected" || outcome.status === "failed"
        ? "errored"
        : "completed";
  const toolDelivered =
    outcome?.kind === "settled" && hasCompletedSourceReplyDeliveryEvidence(outcome.result);
  const values = {
    runId: result?.runId ?? params.opts?.runId ?? "unknown",
    sessionKey,
    agentId: params.followupRun.run.agentId,
    provider,
    model,
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
