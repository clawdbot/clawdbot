import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

type DynamicToolDiagnosticContext = {
  call: CodexDynamicToolCallParams;
  runId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
};

export function emitDynamicToolStartedDiagnostic(params: DynamicToolDiagnosticContext): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
  });
}

export function emitDynamicToolErrorDiagnostic(
  params: DynamicToolDiagnosticContext & {
    durationMs: number;
  },
): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
    durationMs: params.durationMs,
    errorCategory: "codex_dynamic_tool_error",
  });
}

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
  emitDynamicToolErrorDiagnostic(params);
}
