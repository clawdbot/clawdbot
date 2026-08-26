/**
 * Trusted diagnostics emitted around Codex dynamic tool execution lifecycle.
 */
import { runWithDiagnosticTraceContext } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import {
  createDiagnosticTraceContextFromActiveScope,
  emitTrustedDiagnosticEvent,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

type DynamicToolDiagnosticContext = {
  call: CodexDynamicToolCallParams;
  agentId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  trace?: DiagnosticTraceContext | undefined;
};

function dynamicToolDiagnosticEventBase(params: DynamicToolDiagnosticContext) {
  return {
    agentId: params.agentId,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    trace: params.trace,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
  };
}

/** Starts one diagnostic child and installs it around the dynamic handler. */
export function startDynamicToolDiagnosticExecution<T>(
  params: DynamicToolDiagnosticContext,
  execute: () => T,
) {
  const trace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...dynamicToolDiagnosticEventBase({ ...params, trace }),
  });
  return {
    trace,
    execution: runWithDiagnosticTraceContext(trace, execute),
  };
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
    ...dynamicToolDiagnosticEventBase(params),
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
      ...dynamicToolDiagnosticEventBase(params),
      durationMs: params.durationMs,
    });
    return;
  }
  if (terminalType === "blocked") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      ...dynamicToolDiagnosticEventBase(params),
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
