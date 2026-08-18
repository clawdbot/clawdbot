import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticToolExecutionErrorEvent,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
} from "../../infra/diagnostic-events.js";
import type {
  CliBackendConfig,
  CliBackendParseJsonlEvent,
} from "../../plugins/cli-backend.types.js";
import type {
  CliOutput,
  CliStreamingDelta,
  CliStreamJsonOutputLimits,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolResultDelta,
  CliToolUseStartDelta,
  CliUsage,
} from "../cli-output-contracts.js";
import { pickCliSessionId } from "../cli-output-records.js";
import {
  CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  CLI_STREAM_JSON_OUTPUT_LIMITS,
  createCliJsonlStreamingParser,
  frameBoundedCliJsonlChunk,
  normalizeClaudeCliStreamJsonRecord,
} from "../cli-output-stream.js";
import { parseCliOutput } from "../cli-output.js";
import type { FailoverError } from "../failover-error.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import {
  armClaudeTurnTimers,
  clearClaudeTurnTimers,
  resetClaudeNoOutputTimer,
} from "./claude-live-turn-timeouts.js";
import { createCliExitFailoverError, createCliFailoverError } from "./exit-error.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import { createCliOutputFailoverError } from "./output-error.js";
import type { PreparedCliRunContext } from "./types.js";

export type ClaudeLiveExecPermission = {
  security: import("../../infra/exec-approvals.js").ExecSecurity;
  ask: import("../../infra/exec-approvals.js").ExecAsk;
  permissionMode: "bypassPermissions" | "default";
};

export type ClaudeLiveToolTerminalOutcome =
  | { outcome: "blocked"; deniedReason: string; reason?: string }
  | { outcome: "cancelled" | "failed" | "timed_out" | "unknown" };

type ClaudeLiveActiveTool = {
  toolName: string;
  toolCallId: string;
  kind: CliToolUseStartDelta["kind"];
  startedAt: number;
};

export type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  cwd: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  diagnosticRefs: {
    runId: string;
    sessionId: string;
    sessionKey?: string;
    agentId?: string;
  };
  abortSignal?: AbortSignal;
  outputLimits: CliStreamJsonOutputLimits;
  startedAtMs: number;
  rawLines: string[];
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  lastOutputAtMs: number | null;
  timeoutTimer: NodeJS.Timeout | null;
  activeTools: Map<string, ClaudeLiveActiveTool>;
  observedStdout: boolean;
  inputUuid: string;
  inputStarted: boolean;
  onSessionId?: (sessionId: string) => void;
  useResume: boolean;
  hasReplayUnsafeActivity: boolean;
  completedToolCallIds: Set<string>;
  toolEventCount: number;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  onCliOutput?: (chunk: string, stream: "stderr" | "stdout") => void;
  onPhase?: (phase: "send" | "resolve") => void;
  execPermission: ClaudeLiveExecPermission;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
};

export type ClaudeLiveTurnHost = {
  backend: CliBackendConfig;
  providerId: string;
  modelId: string;
  noOutputTimeoutMs: number;
  stderr: string;
  stdoutBuffer: { pending: string };
  currentTurn: ClaudeLiveTurn | null;
  outstandingBackgroundTaskIds: Set<string>;
  liveSessionCapabilityReady: boolean;
  closing: boolean;
  close(reason: "idle" | "restart" | "abort" | "mcp-capture-rotation", error?: unknown): void;
  scheduleIdleClose(): void;
  acceptControlResponse(parsed: Record<string, unknown>): boolean;
  acceptControlRequest(turn: ClaudeLiveTurn, parsed: Record<string, unknown>): void;
  acceptSessionRequirement(parsed: Record<string, unknown>): boolean;
  acceptSessionId(sessionId: string): void;
  settleControlRequest(): void;
  cleanupAfterExit(): void;
};

function finishClaudeTurn(host: ClaudeLiveTurnHost, output: CliOutput): void {
  const turn = host.currentTurn;
  if (!turn) {
    return;
  }
  cliBackendLog.info(
    `claude live session turn: provider=${host.providerId} model=${host.modelId} durationMs=${Date.now() - turn.startedAtMs} rawLines=${turn.rawLines.length} ${formatCliBackendOutputDigest(output.text)}`,
  );
  turn.streamingParser.finish();
  failActiveClaudeLiveTools(turn, new Error("Tool result missing before turn completed"));
  clearClaudeTurnTimers(turn);
  host.outstandingBackgroundTaskIds.clear();
  host.currentTurn = null;
  turn.resolve(output);
  host.scheduleIdleClose();
}

export function failClaudeTurn(host: ClaudeLiveTurnHost, error: unknown): void {
  const turn = host.currentTurn;
  if (!turn) {
    return;
  }
  const errorKind = error instanceof Error ? error.name : typeof error;
  cliBackendLog.warn(
    `claude live session turn failed: provider=${host.providerId} model=${host.modelId} durationMs=${Date.now() - turn.startedAtMs} error=${errorKind}`,
  );
  turn.streamingParser.finish();
  failActiveClaudeLiveTools(turn, error);
  clearClaudeTurnTimers(turn);
  host.outstandingBackgroundTaskIds.clear();
  host.currentTurn = null;
  turn.reject(error);
}

export function createClaudeOutputLimitError(
  host: ClaudeLiveTurnHost,
  message: string,
): FailoverError {
  return createCliFailoverError(message, "format", {
    provider: host.providerId,
    model: host.modelId,
  });
}

function diagnosticBase(turn: ClaudeLiveTurn) {
  return {
    runId: turn.diagnosticRefs.runId,
    sessionId: turn.diagnosticRefs.sessionId,
    ...(turn.diagnosticRefs.sessionKey ? { sessionKey: turn.diagnosticRefs.sessionKey } : {}),
    ...(turn.diagnosticRefs.agentId ? { agentId: turn.diagnosticRefs.agentId } : {}),
  };
}

function emitProgress(turn: ClaudeLiveTurn, reason: string): void {
  emitTrustedDiagnosticEvent({ type: "run.progress", ...diagnosticBase(turn), reason });
}

function toolSource(toolName: string): DiagnosticToolSource {
  return toolName.startsWith("mcp__") ? "mcp" : "core";
}

function summarizeToolInput(input: unknown): DiagnosticToolParamsSummary | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return { kind: "null" };
  }
  if (Array.isArray(input)) {
    return { kind: "array", length: input.length };
  }
  switch (typeof input) {
    case "object":
      return { kind: "object" };
    case "string":
      return { kind: "string", length: input.length };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "undefined":
      return { kind: "undefined" };
    default:
      return { kind: "other" };
  }
}

function markClaudeLiveToolStarted(turn: ClaudeLiveTurn, tool: CliToolUseStartDelta): void {
  if (turn.completedToolCallIds.has(tool.toolCallId) || turn.activeTools.has(tool.toolCallId)) {
    return;
  }
  const now = Date.now();
  turn.activeTools.set(tool.toolCallId, {
    toolName: tool.name,
    toolCallId: tool.toolCallId,
    kind: tool.kind,
    startedAt: now,
  });
  turn.toolEventCount += 1;
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...diagnosticBase(turn),
    toolName: tool.name,
    toolSource: toolSource(tool.name),
    toolOwner: "claude-cli",
    toolCallId: tool.toolCallId,
    paramsSummary: summarizeToolInput(tool.args),
  });
  emitProgress(turn, "cli_live:tool_started");
}

function markClaudeLiveToolCompleted(
  turn: ClaudeLiveTurn,
  result: CliToolResultDelta,
  terminalOutcome?: ClaudeLiveToolTerminalOutcome,
): void {
  if (turn.completedToolCallIds.has(result.toolCallId)) {
    return;
  }
  turn.toolEventCount += 1;
  const activeTool = turn.activeTools.get(result.toolCallId);
  if (!activeTool) {
    emitProgress(turn, "cli_live:tool_result");
    return;
  }
  turn.activeTools.delete(result.toolCallId);
  turn.completedToolCallIds.add(result.toolCallId);
  const event = {
    ...diagnosticBase(turn),
    toolName: activeTool.toolName,
    toolSource: toolSource(activeTool.toolName),
    toolOwner: "claude-cli" as const,
    toolCallId: activeTool.toolCallId,
    durationMs: Math.max(0, Date.now() - activeTool.startedAt),
  };
  if (terminalOutcome?.outcome === "blocked") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      ...event,
      deniedReason: terminalOutcome.deniedReason,
      reason: terminalOutcome.reason ?? "blocked by before-tool policy",
    });
  } else if (terminalOutcome?.outcome === "unknown") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
      errorCategory: "cli_tool_ambiguous",
      errorCode: "tool_outcome_unknown",
    });
  } else if (terminalOutcome || result.isError) {
    const terminalReason = terminalOutcome?.outcome ?? "failed";
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
      errorCategory: terminalReason === "cancelled" ? "aborted" : "tool_failed",
      terminalReason,
    });
  } else {
    emitTrustedDiagnosticEvent({ type: "tool.execution.completed", ...event });
  }
  emitProgress(turn, "cli_live:tool_result");
}

export function markClaudeLiveToolDenied(turn: ClaudeLiveTurn, tool: CliToolUseStartDelta): void {
  markClaudeLiveToolStarted(turn, tool);
  markClaudeLiveToolCompleted(
    turn,
    { toolCallId: tool.toolCallId, name: tool.name, isError: true },
    {
      outcome: "blocked",
      deniedReason: "cli_live_exec_policy",
      reason: "blocked by CLI live execution policy",
    },
  );
}

function failActiveClaudeLiveTools(turn: ClaudeLiveTurn, error: unknown): void {
  const terminalReason = resolveCliToolTerminalReason({ error, abortSignal: turn.abortSignal });
  const errorCategory =
    terminalReason === "timed_out"
      ? "timeout"
      : terminalReason === "cancelled"
        ? "aborted"
        : "error";
  for (const activeTool of turn.activeTools.values()) {
    const event: Omit<DiagnosticToolExecutionErrorEvent, "seq" | "ts" | "type" | "errorCategory"> =
      {
        ...diagnosticBase(turn),
        toolName: activeTool.toolName,
        toolSource: toolSource(activeTool.toolName),
        toolOwner: "claude-cli",
        toolCallId: activeTool.toolCallId,
        durationMs: Math.max(0, Date.now() - activeTool.startedAt),
      };
    emitTrustedDiagnosticEvent(
      activeTool.kind === "server_tool_use"
        ? {
            type: "tool.execution.error",
            ...event,
            errorCategory: "cli_tool_ambiguous",
            errorCode: "tool_outcome_unknown",
          }
        : { type: "tool.execution.error", ...event, errorCategory, terminalReason },
    );
  }
  turn.activeTools.clear();
}

function noteClaudeLiveProgress(
  turn: ClaudeLiveTurn,
  parsed: Record<string, unknown>,
  sawToolEvent: boolean,
): void {
  if (parsed.type === "result") {
    emitProgress(turn, "cli_live:result");
    return;
  }
  if (sawToolEvent) {
    return;
  }
  emitProgress(turn, "cli_live:stream_progress");
}

const RESULT_HOLDING_BACKGROUND_TASK_TYPES = new Set(["local_agent", "local_workflow"]);

function applyBackgroundTasksChanged(
  host: ClaudeLiveTurnHost,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type !== "system" || parsed.subtype !== "background_tasks_changed") {
    return;
  }
  host.outstandingBackgroundTaskIds.clear();
  for (const task of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
    if (!isRecord(task)) {
      continue;
    }
    const taskType = typeof task.task_type === "string" ? task.task_type.trim() : "";
    const taskId = typeof task.task_id === "string" ? task.task_id.trim() : "";
    if (RESULT_HOLDING_BACKGROUND_TASK_TYPES.has(taskType) && taskId) {
      host.outstandingBackgroundTaskIds.add(taskId);
    }
  }
}

function pushTurnLine(host: ClaudeLiveTurnHost, turn: ClaudeLiveTurn, line: string): boolean {
  turn.streamingParser.push(`${line}\n`);
  if (!turn.streamingParser.getErrorText()) {
    return true;
  }
  host.close("abort", createClaudeOutputLimitError(host, "Claude CLI turn output exceeded limit."));
  return false;
}

function acceptClaudeLine(host: ClaudeLiveTurnHost, line: string): void {
  const turn = host.currentTurn;
  const trimmed = line.trim();
  if (!trimmed) {
    if (turn) {
      pushTurnLine(host, turn, line);
    }
    return;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(trimmed);
    parsed = isRecord(candidate) ? candidate : null;
  } catch {}
  if (turn) {
    turn.observedStdout = true;
  }
  if (!parsed) {
    if (turn) {
      turn.hasReplayUnsafeActivity = true;
    }
    return;
  }
  const parsedSessionId = pickCliSessionId(parsed, host.backend);
  if (parsedSessionId) {
    host.acceptSessionId(parsedSessionId);
    if (parsed.type === "system" && parsed.subtype === "init") {
      turn?.onSessionId?.(parsedSessionId);
    }
  }
  if (host.acceptControlResponse(parsed) || !turn) {
    return;
  }
  if (
    parsed.type === "command_lifecycle" &&
    parsed.command_uuid === turn.inputUuid &&
    parsed.state === "started" &&
    !turn.inputStarted
  ) {
    turn.inputStarted = true;
    emitProgress(turn, "cli_live:input_started");
  }
  if (!host.acceptSessionRequirement(parsed)) {
    return;
  }
  if (!host.liveSessionCapabilityReady) {
    return;
  }
  if (!turn.inputStarted) {
    if (!(parsed.type === "system" && parsed.subtype === "init")) {
      turn.hasReplayUnsafeActivity = true;
    }
    return;
  }
  if (
    !(parsed.type === "system" && parsed.subtype === "init") &&
    parsed.type !== "command_lifecycle"
  ) {
    turn.hasReplayUnsafeActivity = true;
  }
  const normalizedLine = normalizeClaudeCliStreamJsonRecord(parsed)?.line ?? trimmed;
  turn.rawLines.push(normalizedLine);
  applyBackgroundTasksChanged(host, parsed);
  const toolEventCountBefore = turn.toolEventCount;
  if (!pushTurnLine(host, turn, line)) {
    return;
  }
  turn.sessionId = parsedSessionId ?? turn.sessionId;
  noteClaudeLiveProgress(turn, parsed, turn.toolEventCount !== toolEventCountBefore);
  host.acceptControlRequest(turn, parsed);
  if (parsed.type !== "result") {
    return;
  }
  turn.onPhase?.("resolve");
  const raw = turn.rawLines.join("\n");
  const output =
    turn.streamingParser.getOutput() ??
    parseCliOutput({
      raw,
      backend: turn.backend,
      providerId: host.providerId,
      parseJsonlEvent: turn.parseJsonlEvent,
      outputMode: "jsonl",
      fallbackSessionId: turn.sessionId,
    });
  const syntheticNoResponsePendingContinuation =
    output.terminalFailure?.reason === "synthetic_no_response" &&
    host.outstandingBackgroundTaskIds.size > 0;
  if (output.errorText && !syntheticNoResponsePendingContinuation) {
    const error = createCliOutputFailoverError({
      output,
      provider: host.providerId,
      model: host.modelId,
      runId: turn.diagnosticRefs.runId,
      sessionId: turn.diagnosticRefs.sessionId,
    });
    if (error) {
      failClaudeTurn(host, error);
    }
    host.scheduleIdleClose();
    return;
  }
  if (host.outstandingBackgroundTaskIds.size > 0) {
    turn.onPhase?.("send");
    emitProgress(turn, "cli_live:result_deferred_background_tasks");
    return;
  }
  finishClaudeTurn(host, output);
}

export function acceptClaudeStdout(host: ClaudeLiveTurnHost, chunk: string): void {
  host.currentTurn?.onCliOutput?.(chunk, "stdout");
  resetClaudeNoOutputTimer(host, host.currentTurn);
  const maxPendingLineChars =
    host.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  try {
    if (
      !frameBoundedCliJsonlChunk(host.stdoutBuffer, chunk, maxPendingLineChars, (line) => {
        acceptClaudeLine(host, line);
        return !host.closing;
      })
    ) {
      host.close(
        "abort",
        createClaudeOutputLimitError(host, "Claude CLI JSONL line exceeded output limit."),
      );
    }
  } catch (error) {
    host.close("abort", error);
  }
}

export function acceptClaudeExit(host: ClaudeLiveTurnHost, exitCode: number | null): void {
  host.closing = true;
  host.settleControlRequest();
  host.cleanupAfterExit();
  if (!host.currentTurn) {
    return;
  }
  if (host.stdoutBuffer.pending.trim()) {
    const pendingLine = host.stdoutBuffer.pending;
    host.stdoutBuffer.pending = "";
    try {
      acceptClaudeLine(host, pendingLine);
    } catch (error) {
      failClaudeTurn(host, error);
      return;
    }
  }
  if (!host.currentTurn) {
    return;
  }
  const stderr = host.stderr.trim();
  const turn = host.currentTurn;
  failClaudeTurn(
    host,
    createCliExitFailoverError({
      context: { provider: host.providerId, model: host.modelId },
      candidates: [stderr],
      fallbackMessage:
        exitCode === 0 ? "Claude CLI exited before completing the turn." : "Claude CLI failed.",
      emptyReason: exitCode === 0 ? "empty_response" : undefined,
      retryEmptyFailure: !turn.observedStdout && turn.rawLines.length === 0,
    }),
  );
}

export function createClaudeTurn(params: {
  context: PreparedCliRunContext;
  inputUuid: string;
  useResume: boolean;
  host: ClaudeLiveTurnHost;
  execPermission: ClaudeLiveExecPermission;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolUseUpdate?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  resolveToolResultTerminalOutcome?: (
    delta: CliToolResultDelta,
  ) => ClaudeLiveToolTerminalOutcome | undefined;
  onCommentaryText?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
  onCliOutput?: (chunk: string, stream: "stderr" | "stdout") => void;
  onPhase?: (phase: "send" | "resolve") => void;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  const turn: ClaudeLiveTurn = {
    backend: params.context.preparedBackend.backend,
    cwd: params.context.cwd ?? params.context.workspaceDir,
    parseJsonlEvent: params.context.backendResolved.parseJsonlEvent,
    diagnosticRefs: {
      runId: params.context.params.runId,
      sessionId: params.context.params.sessionId,
      ...(params.context.params.sessionKey ? { sessionKey: params.context.params.sessionKey } : {}),
      ...(params.context.params.agentId ? { agentId: params.context.params.agentId } : {}),
    },
    abortSignal: params.context.params.abortSignal,
    outputLimits: CLI_STREAM_JSON_OUTPUT_LIMITS,
    startedAtMs: Date.now(),
    rawLines: [],
    noOutputTimer: null,
    lastOutputAtMs: null,
    timeoutTimer: null,
    activeTools: new Map(),
    observedStdout: false,
    inputUuid: params.inputUuid,
    inputStarted: false,
    onSessionId: params.onSessionId,
    useResume: params.useResume,
    hasReplayUnsafeActivity: false,
    completedToolCallIds: new Set(),
    toolEventCount: 0,
    streamingParser: createCliJsonlStreamingParser({
      backend: params.context.preparedBackend.backend,
      providerId: params.context.backendResolved.id,
      parseJsonlEvent: params.context.backendResolved.parseJsonlEvent,
      onAssistantDelta: params.onAssistantDelta,
      onThinkingDelta: params.onThinkingDelta,
      onThinkingProgress: params.onThinkingProgress,
      onToolUseStart: (delta) => {
        markClaudeLiveToolStarted(turn, delta);
        params.onToolUseStart?.(delta);
      },
      onToolUseUpdate: params.onToolUseUpdate,
      onToolResult: (delta) => {
        markClaudeLiveToolCompleted(turn, delta, params.resolveToolResultTerminalOutcome?.(delta));
        params.onToolResult?.(delta);
      },
      onCommentaryText: params.onCommentaryText,
      onSessionId: params.onSessionId,
      onAssistantMessage: params.onAssistantMessage,
      onUsage: params.onUsage,
    }),
    onCliOutput: params.onCliOutput,
    onPhase: params.onPhase,
    execPermission: params.execPermission,
    resolve: params.resolve,
    reject: params.reject,
  };
  armClaudeTurnTimers(params.host, turn, params.context.params.timeoutMs);
  return turn;
}
