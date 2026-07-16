/**
 * Timeout, terminal-release, and diagnostic helpers for Codex dynamic tool
 * calls.
 */
import {
  embeddedAgentLog,
  formatToolExecutionErrorMessage,
  resolveToolExecutionErrorKind,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  hasPendingInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  addTimerTimeoutGraceMs,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  createFailedDynamicToolResponse,
  type CodexDynamicToolRuntimeResponse,
  withDynamicToolTerminalResolution,
} from "./dynamic-tool-response-state.js";
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

export { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolDiagnosticTerminalReason,
  type JsonValue,
} from "./protocol.js";

/** Default timeout for Codex dynamic tool calls. */
const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
/** Hard cap for per-call Codex dynamic tool timeout overrides. */
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
// timeoutSeconds is an inner tool budget. Keep enough outer-watchdog headroom
// for bounded setup RPCs and the tool's structured timeout result to complete.
const CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS = 30_000;
const CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS = 120_000;
const CODEX_DYNAMIC_COMPUTER_GATEWAY_TIMEOUT_MS = 30_000;
const CODEX_DYNAMIC_COMPUTER_COMPLETION_GRACE_MS = 30_000;
/** Timeout for image-understanding style dynamic tool calls. */
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
/** Timeout for message-delivery dynamic tool calls. */
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS;
const LOG_FIELD_MAX_LENGTH = 160;

type DynamicToolTimeoutDetails = {
  responseMessage: string;
  consoleMessage: string;
  meta: Record<string, unknown>;
};

function normalizeLogField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replaceAll(String.fromCharCode(27), " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > LOG_FIELD_MAX_LENGTH
    ? `${truncateUtf16Safe(normalized, LOG_FIELD_MAX_LENGTH - 3)}...`
    : normalized;
}

function readNumericTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = parseStrictNonNegativeInteger(value);
    if (parsed !== undefined) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return undefined;
}

function formatDynamicToolTimeoutDetails(params: {
  call: CodexDynamicToolCallParams;
  timeoutMs: number;
}): DynamicToolTimeoutDetails {
  const tool = normalizeLogField(params.call.tool) ?? "unknown";
  const baseMeta: Record<string, unknown> = {
    tool: params.call.tool,
    toolCallId: params.call.callId,
    threadId: params.call.threadId,
    turnId: params.call.turnId,
    timeoutMs: params.timeoutMs,
    timeoutKind: "codex_dynamic_tool_rpc",
  };

  if (tool !== "process" || !isJsonObject(params.call.arguments)) {
    return {
      responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms while running tool ${tool}.`,
      consoleMessage: `codex dynamic tool timeout: tool=${tool} toolTimeoutMs=${params.timeoutMs}; per-tool-call watchdog, not session idle`,
      meta: baseMeta,
    };
  }

  const action = normalizeLogField(params.call.arguments.action);
  const sessionId = normalizeLogField(params.call.arguments.sessionId);
  const requestedTimeoutMs = readNumericTimeoutMs(params.call.arguments.timeout);
  const actionPart = action ? ` action=${action}` : "";
  const sessionPart = sessionId ? ` sessionId=${sessionId}` : "";
  const requestedPart =
    requestedTimeoutMs === undefined ? "" : ` requestedWaitMs=${requestedTimeoutMs}`;
  const retryHint =
    action === "poll"
      ? "; repeated lines usually mean process-poll retry churn, not model progress"
      : "";
  const responseTarget =
    action || sessionId
      ? ` while waiting for process${actionPart}${sessionPart}`
      : " while waiting for the process tool";

  return {
    responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms${responseTarget}. This is a tool RPC timeout, not a session idle timeout.`,
    consoleMessage: `codex process tool timeout:${actionPart}${sessionPart} toolTimeoutMs=${params.timeoutMs}${requestedPart}; per-tool-call watchdog, not session idle${retryHint}`,
    meta: {
      ...baseMeta,
      processAction: action,
      processSessionId: sessionId,
      processRequestedTimeoutMs: requestedTimeoutMs,
    },
  };
}

/**
 * Runs a dynamic tool call with run-abort and per-call timeout handling,
 * returning a Codex protocol response instead of throwing.
 */
export async function handleDynamicToolCallWithTimeout(params: {
  call: CodexDynamicToolCallParams;
  toolBridge: Pick<CodexDynamicToolBridge, "handleToolCall" | "consumeToolExecutionSnapshot">;
  signal: AbortSignal;
  timeoutMs: number;
  toolMeta?: string;
  toolCallOrdinal?: number;
  onAgentToolResult?: EmbeddedRunAttemptParams["onAgentToolResult"];
  onFallbackSelected?: () => void;
  onTimeout?: () => void;
  observeToolTerminal?: EmbeddedRunAttemptParams["observeToolTerminal"];
}): Promise<CodexDynamicToolRuntimeResponse> {
  // Timeout or run abort can win while a tool ignores cancellation. Keep the
  // private observer terminal result exactly once across those competing paths.
  let didNotifyAgentToolResult = false;
  const conservativeRaceResponses = new WeakSet<CodexDynamicToolRuntimeResponse>();
  const finalizeTerminal = (response: CodexDynamicToolRuntimeResponse) => {
    const executionSnapshot = params.toolBridge.consumeToolExecutionSnapshot?.(params.call.callId);
    // The host observer owns active wrapper state. A bridge snapshot is only needed
    // after that wrapper settles while result post-processing remains pending.
    const observedExecutionStarted =
      executionSnapshot?.executionStarted ??
      (conservativeRaceResponses.has(response) ? undefined : response.executionStarted);
    const terminalResolution = params.observeToolTerminal?.({
      toolCallId: params.call.callId,
      toolName: params.call.tool,
      arguments:
        response.executedArguments ?? executionSnapshot?.executedArguments ?? params.call.arguments,
      ...(params.toolMeta ? { meta: params.toolMeta } : {}),
      ...(observedExecutionStarted !== undefined
        ? { executionStarted: observedExecutionStarted }
        : {}),
      outcome: response.success ? "success" : "failure",
      ...(!response.success ? { failure: { error: readDynamicToolResponseText(response) } } : {}),
    });
    return withDynamicToolTerminalResolution(response, terminalResolution);
  };
  // The host observer replaces these conservative facts with exact boundary evidence.
  // Direct/older callers without one must still treat a raced terminal as dispatched.
  const createFailedAfterPossibleDispatch = (
    message: string,
    terminalReason: CodexDynamicToolDiagnosticTerminalReason,
  ) => {
    const response = createFailedDynamicToolResponse(message, {
      executionStarted: true,
      sideEffectEvidence: true,
      terminalReason,
    });
    conservativeRaceResponses.add(response);
    return response;
  };
  const notifyAgentToolResult = (
    event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentToolResult"]>>[0],
  ) => {
    if (didNotifyAgentToolResult) {
      return;
    }
    didNotifyAgentToolResult = true;
    try {
      params.onAgentToolResult?.(event);
    } catch (error) {
      embeddedAgentLog.warn(
        `onAgentToolResult handler failed: tool=${params.call.tool} error=${String(error)}`,
      );
    }
  };
  const notifyFailedToolResult = (
    message: string,
    terminalReason: "failed" | "cancelled" | "timed_out" = "failed",
  ) => {
    notifyAgentToolResult({
      toolName: params.call.tool,
      result: {
        content: [{ type: "text", text: message }],
        details: { status: terminalReason, error: message },
      },
      isError: true,
    });
  };
  if (params.signal.aborted) {
    const message = "OpenClaw dynamic tool call aborted before execution.";
    const terminalReason = resolveCodexToolAbortTerminalReason(params.signal);
    params.onFallbackSelected?.();
    notifyFailedToolResult(message, terminalReason);
    return finalizeTerminal(
      createFailedDynamicToolResponse(message, {
        executionStarted: false,
        terminalReason,
      }),
    );
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let resolveAbort: ((response: CodexDynamicToolRuntimeResponse) => void) | undefined;
  const abortFromRun = () => {
    const message = "OpenClaw dynamic tool call aborted.";
    const terminalReason = resolveCodexToolAbortTerminalReason(params.signal);
    params.onFallbackSelected?.();
    controller.abort(params.signal.reason ?? new Error(message));
    notifyFailedToolResult(message, terminalReason);
    resolveAbort?.(createFailedAfterPossibleDispatch(message, terminalReason));
  };
  const abortPromise = new Promise<CodexDynamicToolRuntimeResponse>((resolve) => {
    resolveAbort = resolve;
  });
  const timeoutPromise = new Promise<CodexDynamicToolRuntimeResponse>((resolve) => {
    const timeoutMs = clampDynamicToolTimeoutMs(params.timeoutMs);
    timeout = setTimeout(() => {
      timedOut = true;
      const timeoutDetails = formatDynamicToolTimeoutDetails({ call: params.call, timeoutMs });
      params.onFallbackSelected?.();
      controller.abort(new Error(timeoutDetails.responseMessage));
      params.onTimeout?.();
      embeddedAgentLog.warn("codex dynamic tool call timed out", {
        ...timeoutDetails.meta,
        consoleMessage: timeoutDetails.consoleMessage,
      });
      notifyFailedToolResult(timeoutDetails.responseMessage, "timed_out");
      resolve(createFailedAfterPossibleDispatch(timeoutDetails.responseMessage, "timed_out"));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    params.signal.addEventListener("abort", abortFromRun, { once: true });
    if (params.signal.aborted) {
      abortFromRun();
    }
    const response = await Promise.race([
      params.toolBridge.handleToolCall(params.call, {
        signal: controller.signal,
        onAgentToolResult: notifyAgentToolResult,
        toolCallOrdinal: params.toolCallOrdinal,
        retainExecutionSnapshot: true,
      }),
      abortPromise,
      timeoutPromise,
    ]);
    if (!response.success && !didNotifyAgentToolResult) {
      notifyFailedToolResult(
        readDynamicToolResponseText(response),
        response.diagnosticTerminalReason ?? "failed",
      );
    }
    return finalizeTerminal(response);
  } catch (error) {
    const terminalReason = params.signal.aborted
      ? resolveCodexToolAbortTerminalReason(params.signal)
      : resolveToolExecutionErrorKind(error);
    const message = formatToolExecutionErrorMessage(error, "OpenClaw dynamic tool call failed.");
    notifyFailedToolResult(message, terminalReason);
    return finalizeTerminal(createFailedAfterPossibleDispatch(message, terminalReason));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    params.signal.removeEventListener("abort", abortFromRun);
    resolveAbort = undefined;
    if (!timedOut && !controller.signal.aborted) {
      controller.abort(new Error("OpenClaw dynamic tool call finished."));
    }
  }
}

function readDynamicToolResponseText(response: CodexDynamicToolCallResponse): string {
  const text = response.contentItems
    .flatMap((item) =>
      item.type === "inputText" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim();
  return text || "OpenClaw dynamic tool call failed.";
}

/** Strips OpenClaw-only metadata before sending a dynamic tool response to Codex. */
export function toCodexDynamicToolProtocolResponse(
  response: CodexDynamicToolRuntimeResponse,
): CodexDynamicToolCallResponse {
  return {
    contentItems: response.contentItems,
    success: response.success,
  };
}

/** Adds async-started progress details when a tool result continues out of band. */
export function toCodexDynamicToolProgressResponse(
  response: CodexDynamicToolRuntimeResponse,
  protocolResponse: CodexDynamicToolCallResponse,
): CodexDynamicToolCallResponse & { details?: { async: true; status: "started" } } {
  if (response.asyncStarted !== true) {
    return protocolResponse;
  }
  return {
    ...protocolResponse,
    details: { async: true, status: "started" },
  };
}

type TerminalToolExecutionDiagnostic = Extract<
  DiagnosticEventPayload,
  { type: "tool.execution.blocked" | "tool.execution.completed" | "tool.execution.error" }
>;

type TerminalDynamicToolReleaseState = {
  completed: boolean;
  aborted: boolean;
  responseSuccess: boolean;
  currentTurnHadNonTerminalDynamicToolResult: boolean;
  activeAppServerTurnRequests: number;
  activeTurnItemIdsCount: number;
  pendingOpenClawDynamicToolCompletionIdsCount: number;
};

/** Decides whether a terminal dynamic tool response can release the Codex turn. */
export function shouldReleaseTurnAfterTerminalDynamicTool(
  state: TerminalDynamicToolReleaseState,
): boolean {
  return (
    !state.completed &&
    !state.aborted &&
    state.responseSuccess &&
    !state.currentTurnHadNonTerminalDynamicToolResult &&
    state.activeAppServerTurnRequests === 0 &&
    state.activeTurnItemIdsCount === 0 &&
    state.pendingOpenClawDynamicToolCompletionIdsCount === 0
  );
}

/** Returns true when a non-async result should block terminal-release shortcuts. */
export function shouldBlockTerminalReleaseForNonTerminalDynamicToolResult(
  response: CodexDynamicToolCallResponse,
): boolean {
  return response.asyncStarted !== true;
}

/** Action chosen after checking terminal dynamic-tool diagnostics. */
type TerminalDynamicToolBatchAction =
  | "idle"
  | "wait"
  | "clear-nonterminal-batch"
  | "release-pending-terminal";

type TerminalDynamicToolBatchState = {
  activeAppServerTurnRequests: number;
  activeTurnItemIdsCount: number;
  pendingOpenClawDynamicToolCompletionIdsCount: number;
  currentTurnHadNonTerminalDynamicToolResult: boolean;
  hasPendingTerminalDynamicToolRelease: boolean;
};

/** Resolves whether terminal diagnostic state should release, wait, or stay idle. */
export function resolveTerminalDynamicToolBatchAction(
  state: TerminalDynamicToolBatchState,
): TerminalDynamicToolBatchAction {
  if (
    state.activeAppServerTurnRequests > 0 ||
    state.activeTurnItemIdsCount > 0 ||
    state.pendingOpenClawDynamicToolCompletionIdsCount > 0
  ) {
    return "wait";
  }
  if (state.currentTurnHadNonTerminalDynamicToolResult) {
    return "clear-nonterminal-batch";
  }
  if (state.hasPendingTerminalDynamicToolRelease) {
    return "release-pending-terminal";
  }
  return "idle";
}

/** Returns true for diagnostic events that terminate a dynamic tool call. */
export function isDynamicToolTerminalDiagnosticEvent(
  event: DiagnosticEventPayload,
): event is TerminalToolExecutionDiagnostic {
  return (
    event.type === "tool.execution.completed" ||
    event.type === "tool.execution.error" ||
    event.type === "tool.execution.blocked"
  );
}

/** Matches terminal diagnostics to a specific dynamic tool call id/name. */
export function isMatchingDynamicToolTerminalDiagnostic(params: {
  event: TerminalToolExecutionDiagnostic;
  call: CodexDynamicToolCallParams;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): boolean {
  if (
    params.event.toolCallId !== params.call.callId ||
    params.event.toolName !== params.call.tool
  ) {
    return false;
  }
  if (params.runId !== undefined) {
    return params.event.runId === params.runId;
  }
  if (params.sessionId !== undefined) {
    return params.event.sessionId === params.sessionId;
  }
  if (params.sessionKey !== undefined) {
    return params.event.sessionKey === params.sessionKey;
  }
  return (
    params.event.runId === undefined &&
    params.event.sessionId === undefined &&
    params.event.sessionKey === undefined
  );
}

/** Checks pending diagnostics for a terminal event matching a tool call. */
export function hasPendingDynamicToolTerminalDiagnostic(params: {
  call: CodexDynamicToolCallParams;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): boolean {
  return hasPendingInternalDiagnosticEvent((event) => {
    if (!isDynamicToolTerminalDiagnosticEvent(event)) {
      return false;
    }
    return isMatchingDynamicToolTerminalDiagnostic({
      event,
      call: params.call,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
  });
}

/** Resolves per-tool timeout, applying media/message defaults and hard caps. */
export function resolveDynamicToolCallTimeoutMs(params: {
  call: CodexDynamicToolCallParams;
  config: EmbeddedRunAttemptParams["config"];
}): number {
  if (params.call.tool === "computer") {
    return clampDynamicToolTimeoutMs(readComputerToolTimeoutMs(params.call.arguments));
  }
  // The message tool's `timeoutMs` is a Gateway transport budget. Its outer
  // watchdog must also cover bounded same-key reconciliation after that timer.
  if (params.call.tool === "message") {
    return CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS;
  }
  return clampDynamicToolTimeoutMs(
    readDynamicToolCallTimeoutMs(params.call.arguments) ??
      readConfiguredDynamicToolTimeoutMs(params.call.tool, params.config) ??
      CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  );
}

function readComputerToolTimeoutMs(value: JsonValue | undefined): number {
  const args = isJsonObject(value) ? value : undefined;
  const action = typeof args?.action === "string" ? args.action : undefined;
  const gatewayTimeoutMs =
    readPositiveFiniteTimeoutMs(args?.timeoutMs) ?? CODEX_DYNAMIC_COMPUTER_GATEWAY_TIMEOUT_MS;
  // Node discovery can make two calls when it falls back from node.list to the
  // legacy pairing list. Screenshot/wait then capture once; input also acts.
  const gatewayCallCount = action === "screenshot" || action === "wait" ? 3 : 4;
  const durationMs =
    action === "wait" || action === "hold_key"
      ? Math.max(0, Number(args?.duration) || 0) * 1000
      : 0;
  // `timeoutMs` is a per-Gateway-call transport budget, not the whole dynamic
  // tool deadline. Computer use can resolve a node, perform/wait, then capture.
  return (
    durationMs + gatewayCallCount * gatewayTimeoutMs + CODEX_DYNAMIC_COMPUTER_COMPLETION_GRACE_MS
  );
}

function readDynamicToolCallTimeoutMs(value: JsonValue | undefined): number | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const timeoutMs = readPositiveFiniteTimeoutMs(value.timeoutMs);
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const timeoutSecondsMs = readDynamicToolTimeoutSecondsAsMs(value.timeoutSeconds);
  return timeoutSecondsMs === undefined
    ? undefined
    : addTimerTimeoutGraceMs(timeoutSecondsMs, CODEX_DYNAMIC_TOOL_TIMEOUT_SECONDS_GRACE_MS);
}

function readConfiguredDynamicToolTimeoutMs(
  toolName: string,
  config: EmbeddedRunAttemptParams["config"],
): number | undefined {
  if (toolName === "image_generate") {
    const imageGenerationModel = config?.agents?.defaults?.imageGenerationModel;
    if (!imageGenerationModel || typeof imageGenerationModel !== "object") {
      return CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS;
    }
    return (
      readPositiveFiniteTimeoutMs(imageGenerationModel.timeoutMs) ??
      CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS
    );
  }

  if (toolName === "image") {
    return (
      readTimeoutSecondsAsMs(config?.tools?.media?.image?.timeoutSeconds) ??
      CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS
    );
  }

  if (toolName === "message") {
    return CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS;
  }

  return undefined;
}

function readTimeoutSecondsAsMs(value: unknown): number | undefined {
  const seconds = readPositiveFiniteTimeoutMs(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function readDynamicToolTimeoutSecondsAsMs(value: unknown): number | undefined {
  // Model-facing timeoutSeconds schemas use integers. Reject malformed
  // fractions instead of silently shortening the caller's budget.
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return undefined;
  }
  return value * 1000;
}

function readPositiveFiniteTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function clampDynamicToolTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.min(CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}
