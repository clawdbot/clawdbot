import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type {
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolUseStartDelta,
} from "../cli-output-contracts.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import { sanitizeToolArgs, sanitizeToolResult } from "../embedded-agent-tool-results.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { stripOpenClawMcpToolPrefix } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

type CliToolResult = {
  toolCallId: string;
  name: string;
  isError: boolean;
  result?: unknown;
};

function resolveCliToolSource(name: string, kind?: CliToolUseStartDelta["kind"]): "core" | "mcp" {
  return kind === "mcp_tool_use" || name.startsWith("mcp__") ? "mcp" : "core";
}

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
  const toolSummaryById = new Map<string, { name: string; failed: boolean }>();
  // CLI results report an outcome without repeating the request, so the terminal
  // progress event would otherwise describe the output instead of the command.
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();
  const toolSummaryNames: string[] = [];
  const toolSummaryNameSet = new Set<string>();
  const activeParsedTools = new Map<
    string,
    { startedAt: number; toolName: string; kind: CliToolUseStartDelta["kind"] }
  >();
  const rememberToolName = (name: string) => {
    if (!name || toolSummaryNameSet.has(name)) {
      return;
    }
    toolSummaryNameSet.add(name);
    toolSummaryNames.push(name);
  };
  const recordToolStart = (event: CliToolUseStartDelta) => {
    if (event.args && Object.keys(event.args).length > 0) {
      toolArgsByCallId.set(event.toolCallId, event.args);
    }
    const current = toolSummaryById.get(event.toolCallId);
    if (!current) {
      toolSummaryById.set(event.toolCallId, { name: event.name, failed: false });
    } else if (!current.name && event.name) {
      current.name = event.name;
    }
    rememberToolName(event.name);
  };
  const recordToolResult = (event: CliToolResult) => {
    const current = toolSummaryById.get(event.toolCallId);
    if (current) {
      current.failed ||= event.isError;
      if (!current.name && event.name) {
        current.name = event.name;
      }
    } else {
      toolSummaryById.set(event.toolCallId, { name: event.name, failed: event.isError });
    }
    rememberToolName(event.name);
  };
  const getToolSummary = (): ToolSummaryTrace => ({
    calls: toolSummaryById.size,
    tools: toolSummaryNames.slice(),
    failures: Array.from(toolSummaryById.values()).filter((entry) => entry.failed).length,
  });
  const emitCliToolUseStart = (event: CliToolUseStartDelta) => {
    observedCliActivity = true;
    recordToolStart(event);
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
  // Refresh an already-started tool row with resolved args (provider omitted
  // input_json_delta on the start, later assistant snapshot carries them). This
  // is an update, not a second start: it must not re-trigger start-only consumers
  // (e.g. the Discord progress completion receipt). See #120306.
  const emitCliToolUseUpdate = (event: CliToolUseStartDelta) => {
    observedCliActivity = true;
    recordToolStart(event);
    // Refresh the canonical tool-tracking state (loopback correlation and
    // message-delivery evidence) with the recovered args. handleCliToolUseStart
    // only mutates tracking state and emits no lifecycle event, so this does not
    // create a second start.
    params.toolTracking.handleCliToolUseStart(event);
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "tool",
        data: {
          phase: "update",
          name: event.name,
          toolCallId: event.toolCallId,
          args: sanitizeToolArgs(event.args),
        },
      });
    }
  };
  const emitCliToolResult = (event: CliToolResult) => {
    observedCliActivity = true;
    recordToolResult(event);
    params.toolTracking.handleCliToolResult(event);
    if (emitLiveEvents) {
      const resultContentSource = context.resultContentSourceByToolName?.get(
        stripOpenClawMcpToolPrefix(event.name),
      );
      const startedArgs = toolArgsByCallId.get(event.toolCallId);
      toolArgsByCallId.delete(event.toolCallId);
      emitAgentEvent({
        runId: runParams.runId,
        stream: "tool",
        data: {
          phase: "result",
          name: event.name,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: sanitizeToolResult(event.result),
          ...(startedArgs ? { args: sanitizeToolArgs(startedArgs) } : {}),
          ...(resultContentSource ? { resultContentSource } : {}),
        },
      });
    }
  };
  // Plugin-parsed events describe native work already performed by the backend.
  // Render and summarize them without host-tool correlation or delivery evidence.
  const emitCliDisplayToolUseStart = (event: CliToolUseStartDelta) => {
    observedCliActivity = true;
    recordToolStart(event);
    if (!signaledToolExecutionStarted) {
      signaledToolExecutionStarted = true;
      runParams.onExecutionPhase?.({
        phase: "tool_execution_started",
        provider: runParams.provider,
        model: context.modelId,
        backend: context.backendResolved.id,
      });
    }
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
  const emitCliDisplayToolResult = (event: CliToolResult) => {
    observedCliActivity = true;
    recordToolResult(event);
    if (emitLiveEvents) {
      toolArgsByCallId.delete(event.toolCallId);
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
      toolSource: resolveCliToolSource(event.name, event.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
    });
    emitCliToolUseStart(event);
  };
  const emitParsedToolUseUpdate = (event: CliToolUseStartDelta) => {
    emitCliToolUseUpdate(event);
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
      toolSource: resolveCliToolSource(toolName, activeTool?.kind),
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

  return {
    emitLiveEvents,
    emitCliToolUseStart,
    emitCliToolUseUpdate,
    emitCliToolResult,
    emitCliDisplayToolUseStart,
    emitCliDisplayToolResult,
    emitParsedToolUseStart,
    emitParsedToolUseUpdate,
    emitParsedToolResult,
    finalizeParsedTools,
    emitCliCommentaryText,
    emitCliAssistantDelta,
    emitCliThinkingDelta,
    emitCliThinkingProgress,
    hasObservedCliActivity: () => observedCliActivity,
    activeParsedToolCount: () => activeParsedTools.size,
    getToolSummary,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
