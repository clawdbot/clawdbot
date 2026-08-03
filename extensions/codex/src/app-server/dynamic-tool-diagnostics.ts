/**
 * Trusted diagnostics emitted around Codex dynamic tool execution lifecycle.
 */
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

type DynamicToolDiagnosticContext = {
  call: CodexDynamicToolCallParams;
  agentId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
};

/** Emits a start event for one Codex dynamic tool call. */
export function emitDynamicToolStartedDiagnostic(params: DynamicToolDiagnosticContext): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    agentId: params.agentId,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
  });
}

/** Emits an error event for one Codex dynamic tool call. */
export function emitDynamicToolErrorDiagnostic(
  params: DynamicToolDiagnosticContext & {
    durationMs: number;
    terminalReason?: "failed" | "cancelled" | "timed_out";
  },
): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    agentId: params.agentId,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
    durationMs: params.durationMs,
    errorCategory: "codex_dynamic_tool_error",
    terminalReason: params.terminalReason ?? "failed",
  });
}

/** Emits the terminal event matching a dynamic tool response's diagnostic type. */
export function emitDynamicToolTerminalDiagnostic(
  params: DynamicToolDiagnosticContext & {
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  },
): void {
  const terminalType =
    params.response.diagnosticTerminalType ?? (params.response.success ? "completed" : "error");
  if (terminalType === "completed") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      agentId: params.agentId,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      toolName: params.call.tool,
      toolCallId: params.call.callId,
      durationMs: params.durationMs,
    });
    return;
  }
  if (terminalType === "blocked") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      agentId: params.agentId,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      toolName: params.call.tool,
      toolCallId: params.call.callId,
      deniedReason: "plugin-before-tool-call",
      reason: "Tool call blocked",
    });
    return;
  }
  emitDynamicToolErrorDiagnostic({
    ...params,
    terminalReason: params.response.diagnosticTerminalReason ?? "failed",
  });
}
