import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import {
  getTrustedToolExecutionContextLifecycleToken,
  getTrustedToolExecutionLifecycleGeneration,
} from "../infra/trusted-tool-execution-context.js";
import {
  nonEmptyString,
  resolveToolProvenance,
  type AgentAuditProjectionState,
} from "./agent-event-audit-provenance.js";
import { auditSourceIdentity } from "./agent-event-audit-source.js";
import { auditToolCallId, auditToolName } from "./agent-event-audit-tool-identity.js";
import type { ToolActionAuditEventInput } from "./audit-event-types.js";

/** Project the complete trusted tool-execution lifecycle without private diagnostic content. */
export function projectToolExecutionEventToAudit(
  state: AgentAuditProjectionState,
  event: TrustedToolExecutionEvent,
): ToolActionAuditEventInput | undefined {
  // Schema quarantine describes tool availability before invocation. Without
  // a call identity it must not become a durable tool-action claim.
  if (
    event.type === "tool.execution.blocked" &&
    event.deniedReason === "unsupported_tool_schema" &&
    !nonEmptyString(event.toolCallId)
  ) {
    return undefined;
  }
  const runId = nonEmptyString(event.runId);
  const toolName = auditToolName(event.toolName);
  if (!runId || !toolName) {
    return undefined;
  }
  const toolCallId = auditToolCallId(event.toolCallId);
  const capturedLifecycleGeneration = getTrustedToolExecutionLifecycleGeneration(event);
  const contextLifecycleToken = getTrustedToolExecutionContextLifecycleToken(event);
  const { provenance, lifecycleGeneration } = resolveToolProvenance(
    state,
    runId,
    event,
    capturedLifecycleGeneration,
    contextLifecycleToken,
  );
  const occurredAt = asDateTimestampMs(event.sourceTimestampMs) ?? event.ts;
  const attribution = {
    sourceSequence: event.seq,
    occurredAt,
    kind: "tool_action" as const,
    actorType: provenance.actorType,
    actorId: provenance.agentId,
    agentId: provenance.agentId,
    ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    runId,
    ...(toolCallId ? { toolCallId } : {}),
    toolName,
  };
  if (event.type === "tool.execution.started") {
    const action = "tool.action.started" as const;
    return {
      ...auditSourceIdentity({
        runId,
        sourceSequence: event.seq,
        occurredAt,
        action,
        lifecycleGeneration,
      }),
      ...attribution,
      action,
      status: "started",
    };
  }
  const errorCategory =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCategory)
      : undefined;
  const terminalReason = event.type === "tool.execution.error" ? event.terminalReason : undefined;
  const diagnosticErrorCode =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCode)
      : undefined;
  // Modern producers set terminalReason explicitly; errorCategory is only a
  // legacy fallback and must not override a definitive timeout or failure.
  const toolCancelled =
    terminalReason === "cancelled" ||
    (terminalReason === undefined &&
      (errorCategory === "aborted" ||
        errorCategory === "aborterror" ||
        errorCategory === "cancelled" ||
        errorCategory === "canceled"));
  const toolTimedOut = terminalReason === "timed_out";
  // Unknown is an explicit dependency boundary, not a failed-run inference.
  // Keep it authoritative when enclosing run provenance says cancel or timeout.
  const terminal =
    event.type === "tool.execution.completed"
      ? { status: "succeeded" as const }
      : event.type === "tool.execution.blocked"
        ? { status: "blocked" as const, errorCode: "tool_blocked" as const }
        : diagnosticErrorCode === "tool_outcome_unknown"
          ? { status: "unknown" as const, errorCode: "tool_outcome_unknown" as const }
          : toolCancelled
            ? { status: "cancelled" as const, errorCode: "tool_cancelled" as const }
            : toolTimedOut
              ? { status: "timed_out" as const, errorCode: "tool_timed_out" as const }
              : { status: "failed" as const, errorCode: "tool_failed" as const };
  const action = "tool.action.finished" as const;
  return {
    ...auditSourceIdentity({
      runId,
      sourceSequence: event.seq,
      occurredAt,
      action,
      lifecycleGeneration,
    }),
    ...attribution,
    action,
    ...terminal,
  };
}
