import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type {
  CliPlanUpdate,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolUseStartDelta,
} from "../cli-output.js";
import { sanitizeToolArgs, sanitizeToolResult } from "../embedded-agent-subscribe.tools.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

type CliToolResult = {
  toolCallId: string;
  name: string;
  isError: boolean;
  result?: unknown;
};

export function createCliEventHandlers(params: {
  context: PreparedCliRunContext;
  toolTracking: CliToolTracking;
  getRunState: () => { failed: boolean; error: unknown };
}) {
  const context = params.context;
  const runParams = context.params;
  const emitLiveEvents = runParams.executionMode !== "side-question";
  let observedCliActivity = false;
  let signaledToolExecutionStarted = false;
  let signaledAssistantOutputStarted = false;
  let commentaryCounter = 0;
  const activeParsedTools = new Map<
    string,
    { startedAt: number; toolName: string; kind: CliToolUseStartDelta["kind"] }
  >();
  const emitCliToolUseStart = (event: CliToolUseStartDelta) => {
    observedCliActivity = true;
    if (!signaledToolExecutionStarted) {
      signaledToolExecutionStarted = true;
      runParams.onExecutionPhase?.({
        phase: "tool_execution_started",
        provider: runParams.provider,
        model: context.modelId,
        backend: context.backendResolved.id,
      });
    }
    params.toolTracking.handleCliToolUseStart(event);
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: event.name,
          toolCallId: event.toolCallId,
          args: sanitizeToolArgs(event.args),
        },
      });
    }
  };
  const emitCliToolResult = (event: CliToolResult) => {
    observedCliActivity = true;
    params.toolTracking.handleCliToolResult(event);
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "tool",
        data: {
          phase: "result",
          name: event.name,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: sanitizeToolResult(event.result),
        },
      });
    }
  };
  const emitParsedToolUseStart = (event: CliToolUseStartDelta) => {
    const startedAt = Date.now();
    activeParsedTools.set(event.toolCallId, {
      startedAt,
      toolName: event.name,
      kind: event.kind,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName: event.name,
      toolSource: event.name.startsWith("mcp__") ? "mcp" : "core",
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
    });
    emitCliToolUseStart(event);
  };
  const emitParsedToolTerminal = (event: {
    toolCallId: string;
    name: string;
    isError: boolean;
    incomplete?: boolean;
  }) => {
    const activeTool = activeParsedTools.get(event.toolCallId);
    activeParsedTools.delete(event.toolCallId);
    const trustedOutcome = params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId);
    const toolName = activeTool?.toolName ?? event.name;
    const now = Date.now();
    const trustedTerminalReason =
      trustedOutcome &&
      trustedOutcome.outcome !== "blocked" &&
      trustedOutcome.outcome !== "completed" &&
      trustedOutcome.outcome !== "unknown"
        ? trustedOutcome.outcome
        : undefined;
    const runState = params.getRunState();
    const terminalReason =
      trustedTerminalReason ??
      resolveCliToolTerminalReason({
        error: event.incomplete ? runState.error : undefined,
        abortSignal: runParams.abortSignal,
      });
    // Incomplete client/MCP tools inherit the enclosing failed run even when
    // the loopback disconnect is ambiguous. Server-native tools do not.
    const useEnclosingTerminalReason =
      event.incomplete &&
      runState.failed &&
      activeTool !== undefined &&
      activeTool.kind !== "server_tool_use";
    const diagnosticBase = {
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName,
      toolSource: toolName.startsWith("mcp__") ? ("mcp" as const) : ("core" as const),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
      durationMs: Math.max(0, now - (activeTool?.startedAt ?? now)),
    };
    if (trustedOutcome?.outcome === "unknown" && !useEnclosingTerminalReason) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...diagnosticBase,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      return;
    }
    if (event.incomplete && activeTool?.kind === "server_tool_use" && !trustedOutcome) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...diagnosticBase,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      return;
    }
    const trustedFailure = trustedOutcome !== undefined && trustedOutcome.outcome !== "completed";
    emitTrustedDiagnosticEvent(
      trustedOutcome?.outcome === "blocked"
        ? {
            type: "tool.execution.blocked",
            ...diagnosticBase,
            deniedReason: trustedOutcome.deniedReason,
            reason: "blocked by before-tool policy",
          }
        : trustedFailure || (!trustedOutcome && event.isError)
          ? {
              type: "tool.execution.error",
              ...diagnosticBase,
              errorCategory:
                terminalReason === "cancelled"
                  ? "aborted"
                  : event.incomplete && (!trustedOutcome || useEnclosingTerminalReason)
                    ? "cli_tool_incomplete"
                    : "cli_tool",
              terminalReason,
            }
          : { type: "tool.execution.completed", ...diagnosticBase },
    );
  };
  const emitParsedToolResult = (event: CliToolResult) => {
    emitParsedToolTerminal(event);
    emitCliToolResult(event);
  };
  const finalizeParsedTools = () => {
    for (const [toolCallId, activeTool] of Array.from(activeParsedTools)) {
      emitParsedToolTerminal({
        toolCallId,
        name: activeTool.toolName,
        isError: true,
        incomplete: true,
      });
    }
  };
  const emitCliCommentaryText = (text: string) => {
    if (!emitLiveEvents) {
      return;
    }
    commentaryCounter += 1;
    emitAgentEvent({
      runId: runParams.runId,
      stream: "item",
      data: {
        kind: "preamble",
        itemId: `commentary-${runParams.runId}-${commentaryCounter}`,
        phase: "update",
        title: "commentary",
        status: "running",
        progressText: applyPluginTextReplacements(
          text,
          context.backendResolved.textTransforms?.output,
        ),
      },
    });
  };
  const emitCliAssistantDelta = ({ text, delta }: CliStreamingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
      if (!signaledAssistantOutputStarted) {
        signaledAssistantOutputStarted = true;
        runParams.onExecutionPhase?.({
          phase: "assistant_output_started",
          provider: runParams.provider,
          model: context.modelId,
          backend: context.backendResolved.id,
        });
      }
    }
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "assistant",
        data: {
          text: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),
          delta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output),
        },
      });
    }
  };

  // Emit-always: thinking reaches the event bus and session archive like the
  // embedded reasoning stream; /reasoning and /verbose gate presentation only.
  const emitCliThinkingDelta = ({ text, delta, isReasoningSnapshot }: CliThinkingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
    }
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "thinking",
        data: { text, delta, ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}) },
      });
    }
  };

  const emitCliThinkingProgress = ({ progressTokens }: CliThinkingProgress) => {
    observedCliActivity = true;
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "thinking",
        data: { progressTokens },
      });
    }
  };

  const emitCliPlanUpdate = ({ steps }: CliPlanUpdate) => {
    observedCliActivity = true;
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "plan",
        data: { phase: "update", title: "Plan updated", source: "codex-exec", steps },
      });
    }
  };

  return {
    emitLiveEvents,
    emitCliToolUseStart,
    emitCliToolResult,
    emitParsedToolUseStart,
    emitParsedToolResult,
    finalizeParsedTools,
    emitCliCommentaryText,
    emitCliAssistantDelta,
    emitCliThinkingDelta,
    emitCliThinkingProgress,
    emitCliPlanUpdate,
    hasObservedCliActivity: () => observedCliActivity,
    activeParsedToolCount: () => activeParsedTools.size,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
