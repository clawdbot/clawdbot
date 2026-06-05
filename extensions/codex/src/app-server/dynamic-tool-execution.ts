/**
 * Timeout, terminal-release, and diagnostic helpers for Codex dynamic tool
 * calls.
 */
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  hasPendingInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type JsonValue,
} from "./protocol.js";

/** Default timeout for Codex dynamic tool calls. */
export const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;
/** Hard cap for per-call Codex dynamic tool timeout overrides. */
export const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
const CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS = 120_000;
/** Timeout for image-understanding style dynamic tool calls. */
export const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
/** Timeout for message-delivery dynamic tool calls. */
export const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = 120_000;
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
    ? `${normalized.slice(0, LOG_FIELD_MAX_LENGTH - 3)}...`
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
  toolBridge: Pick<CodexDynamicToolBridge, "handleToolCall">;
  signal: AbortSignal;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<CodexDynamicToolCallResponse> {
  if (params.signal.aborted) {
    return failedDynamicToolResponse("OpenClaw dynamic tool call aborted before execution.");
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let resolveAbort: ((response: CodexDynamicToolCallResponse) => void) | undefined;
  const abortFromRun = () => {
    const message = "OpenClaw dynamic tool call aborted.";
    controller.abort(params.signal.reason ?? new Error(message));
    resolveAbort?.(failedDynamicToolResponse(message, { sideEffectEvidence: true }));
  };
  const abortPromise = new Promise<CodexDynamicToolCallResponse>((resolve) => {
    resolveAbort = resolve;
  });
  const timeoutPromise = new Promise<CodexDynamicToolCallResponse>((resolve) => {
    const timeoutMs = clampDynamicToolTimeoutMs(params.timeoutMs);
    timeout = setTimeout(() => {
      timedOut = true;
      const timeoutDetails = formatDynamicToolTimeoutDetails({ call: params.call, timeoutMs });
      controller.abort(new Error(timeoutDetails.responseMessage));
      params.onTimeout?.();
      embeddedAgentLog.warn("codex dynamic tool call timed out", {
        ...timeoutDetails.meta,
        consoleMessage: timeoutDetails.consoleMessage,
      });
      resolve(
        failedDynamicToolResponse(timeoutDetails.responseMessage, { sideEffectEvidence: true }),
      );
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    params.signal.addEventListener("abort", abortFromRun, { once: true });
    if (params.signal.aborted) {
      abortFromRun();
    }
    return await Promise.race([
      params.toolBridge.handleToolCall(params.call, { signal: controller.signal }),
      abortPromise,
      timeoutPromise,
    ]);
  } catch (error) {
    return failedDynamicToolResponse(error instanceof Error ? error.message : String(error), {
      sideEffectEvidence: true,
    });
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

function failedDynamicToolResponse(
  message: string,
  options?: { sideEffectEvidence?: boolean },
): CodexDynamicToolCallResponse {
  const response: CodexDynamicToolCallResponse = {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
  Object.defineProperty(response, "diagnosticTerminalType", {
    configurable: true,
    enumerable: false,
    value: "error",
  });
  if (options?.sideEffectEvidence === true) {
    Object.defineProperty(response, "sideEffectEvidence", {
      configurable: true,
      enumerable: false,
      value: true,
    });
  }
  return response;
}

/** Strips OpenClaw-only metadata before sending a dynamic tool response to Codex. */
export function toCodexDynamicToolProtocolResponse(
  response: CodexDynamicToolCallResponse,
): CodexDynamicToolCallResponse {
  return {
    contentItems: response.contentItems,
    success: response.success,
  };
}

/** Adds async-started progress details when a tool result continues out of band. */
export function toCodexDynamicToolProgressResponse(
  response: CodexDynamicToolCallResponse,
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
export type TerminalDynamicToolBatchAction =
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
  return clampDynamicToolTimeoutMs(
    readDynamicToolCallTimeoutMs(params.call.arguments) ??
      readConfiguredDynamicToolTimeoutMs(params.call.tool, params.config) ??
      CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  );
}

function readDynamicToolCallTimeoutMs(value: JsonValue | undefined): number | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return readPositiveFiniteTimeoutMs(value.timeoutMs);
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

function readPositiveFiniteTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function clampDynamicToolTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.min(CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}
