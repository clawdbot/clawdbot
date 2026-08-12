import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
  type DiagnosticModelCallContent,
} from "../../../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  type DiagnosticModelContentCapturePolicy,
} from "../../../infra/diagnostic-llm-content.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../../../infra/diagnostic-semantic-run-progress.js";
import { markDiagnosticRunProgress } from "../../../logging/diagnostic-run-activity.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../../usage.js";
import type {
  ModelCallEventBase,
  ModelCallObservationState,
  ModelCallObserver,
  ModelCallPromptStats,
  ModelCallSizeTimingFields,
  ModelCallUsage,
} from "./attempt.model-diagnostic-lifecycle.js";

const MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS = 30_000;
const MODEL_CALL_STREAM_PROGRESS_REASON = "model_call:stream_progress";
const MODEL_CALL_SEMANTIC_PROGRESS_REASON = "model_call:semantic_result";

function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function assignRequestPayloadBytes(state: ModelCallObservationState, payload: unknown): void {
  const bytes = utf8JsonByteLength(payload);
  if (bytes !== undefined) {
    state.requestPayloadBytes = bytes;
  }
}

function utf8StringByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonCharLength(value: unknown): number | undefined {
  try {
    return JSON.stringify(value)?.length;
  } catch {
    return undefined;
  }
}

function streamDeltaByteLength(chunk: Record<string, unknown>): number | undefined {
  const type = chunk.type;
  if (
    (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") &&
    typeof chunk.delta === "string"
  ) {
    return utf8StringByteLength(chunk.delta);
  }
  return undefined;
}

function responseStreamChunkByteLengthUnchecked(chunk: unknown): number | undefined {
  if (!isRecord(chunk)) {
    return utf8JsonByteLength(chunk);
  }
  const deltaBytes = streamDeltaByteLength(chunk);
  if (deltaBytes !== undefined) {
    return deltaBytes;
  }
  if (!("partial" in chunk)) {
    return utf8JsonByteLength(chunk);
  }
  // Plain stream deltas can carry an accumulated partial snapshot. Byte metrics
  // count the new stream payload, not the answer-so-far replay.
  const { partial: _partial, ...snapshotlessChunk } = chunk;
  return utf8JsonByteLength(snapshotlessChunk);
}

function responseStreamChunkByteLength(chunk: unknown): number | undefined {
  try {
    return responseStreamChunkByteLengthUnchecked(chunk);
  } catch {
    return undefined;
  }
}

function streamContextModelContentFields(
  policy: DiagnosticModelContentCapturePolicy | undefined,
  streamContext: unknown,
): DiagnosticModelCallContent | undefined {
  if (!policy?.anyModelContent || !isRecord(streamContext)) {
    return undefined;
  }
  const content = {
    ...(policy.inputMessages && Array.isArray(streamContext.messages)
      ? { inputMessages: cloneDiagnosticContentValue(streamContext.messages) }
      : {}),
    ...(policy.systemPrompt && typeof streamContext.systemPrompt === "string"
      ? { systemPrompt: streamContext.systemPrompt }
      : {}),
    ...(policy.toolDefinitions && Array.isArray(streamContext.tools)
      ? { toolDefinitions: cloneDiagnosticContentValue(streamContext.tools) }
      : {}),
  };
  return Object.keys(content).length > 0 ? content : undefined;
}

function streamContextModelPromptStats(streamContext: unknown): ModelCallPromptStats | undefined {
  if (!isRecord(streamContext)) {
    return undefined;
  }
  const messages = Array.isArray(streamContext.messages) ? streamContext.messages : undefined;
  const tools = Array.isArray(streamContext.tools) ? streamContext.tools : undefined;
  const systemPrompt =
    typeof streamContext.systemPrompt === "string" ? streamContext.systemPrompt : undefined;
  const inputMessagesChars = messages ? jsonCharLength(messages) : undefined;
  const toolDefinitionsChars = tools ? jsonCharLength(tools) : undefined;
  const systemPromptChars = systemPrompt?.length;
  if (
    messages === undefined &&
    tools === undefined &&
    systemPromptChars === undefined &&
    inputMessagesChars === undefined &&
    toolDefinitionsChars === undefined
  ) {
    return undefined;
  }
  const totalChars =
    (inputMessagesChars ?? 0) + (systemPromptChars ?? 0) + (toolDefinitionsChars ?? 0);
  return {
    ...(messages ? { inputMessagesCount: messages.length } : {}),
    ...(inputMessagesChars !== undefined ? { inputMessagesChars } : {}),
    ...(systemPromptChars !== undefined ? { systemPromptChars } : {}),
    ...(tools ? { toolDefinitionsCount: tools.length } : {}),
    ...(toolDefinitionsChars !== undefined ? { toolDefinitionsChars } : {}),
    totalChars,
  };
}

function normalizedModelCallUsage(rawUsage: unknown): ModelCallUsage | undefined {
  if (!isRecord(rawUsage)) {
    return undefined;
  }
  const usage = normalizeUsage(rawUsage as UsageLike);
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
  return {
    ...usage,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
  };
}

function observeModelCallUsage(state: ModelCallObservationState, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  let rawUsage: unknown;
  try {
    rawUsage = value.usage;
  } catch {
    return;
  }
  const usage = normalizedModelCallUsage(rawUsage);
  if (usage) {
    state.usage = usage;
  }
}

function observeOutputMessageContent(state: ModelCallObservationState, chunk: unknown): void {
  if (!isRecord(chunk)) {
    return;
  }
  let type: unknown;
  let message: unknown;
  try {
    type = chunk.type;
    message = type === "done" ? chunk.message : type === "error" ? chunk.error : undefined;
  } catch {
    return;
  }
  // Terminal events carry the final AssistantMessage with usage — `done` for
  // success, `error` for aborted/error streams. Capture usage from either so
  // iterated error-terminated calls still report the per-call usage that the
  // model.call.error event and its OTel span already expose.
  if (message !== undefined) {
    observeModelCallUsage(state, message);
    if (state.contentCapture?.outputMessages) {
      state.outputMessages = [cloneDiagnosticContentValue(message)];
    }
  }
}

function observeResultMessageContent(
  state: ModelCallObservationState,
  startedAt: number,
  result: unknown,
): void {
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  observeModelCallUsage(state, result);
  if (state.contentCapture?.outputMessages && state.outputMessages === undefined) {
    state.outputMessages = [cloneDiagnosticContentValue(result)];
  }
  if (state.responseStreamBytes === 0) {
    const bytes = utf8JsonByteLength(result);
    if (bytes !== undefined) {
      state.responseStreamBytes = bytes;
    }
  }
}

function isNormalizedToolCall(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "toolCall") {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    isRecord(value.arguments)
  );
}

function isSemanticModelCallResult(result: unknown): boolean {
  try {
    if (
      !isRecord(result) ||
      result.role !== "assistant" ||
      result.stopReason === "error" ||
      result.stopReason === "aborted" ||
      !Array.isArray(result.content)
    ) {
      return false;
    }
    const hasExecutableToolCall =
      result.stopReason === "toolUse" && result.content.some(isNormalizedToolCall);
    return (
      hasExecutableToolCall ||
      result.content.some(
        (item) =>
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string" &&
          item.text.trim().length > 0,
      )
    );
  } catch {
    return false;
  }
}

function maybeEmitModelCallSemanticProgress(
  eventBase: ModelCallEventBase,
  state: ModelCallObservationState,
  result: unknown,
): void {
  if (state.semanticProgressEmitted || !isSemanticModelCallResult(result)) {
    return;
  }
  state.semanticProgressEmitted = true;
  emitCoreSemanticRunProgressDiagnosticEvent({
    runId: eventBase.runId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    reason: MODEL_CALL_SEMANTIC_PROGRESS_REASON,
  });
}

function observeResponseChunk(
  state: ModelCallObservationState,
  startedAt: number,
  chunk: unknown,
): void {
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  observeOutputMessageContent(state, chunk);
  const bytes = responseStreamChunkByteLength(chunk);
  if (bytes !== undefined) {
    state.responseStreamBytes += bytes;
  }
}

function maybeEmitModelCallStreamProgress(
  eventBase: ModelCallEventBase,
  state: ModelCallObservationState,
): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const now = Date.now();
  const progressFields = {
    runId: eventBase.runId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    reason: MODEL_CALL_STREAM_PROGRESS_REASON,
  };
  markDiagnosticRunProgress(progressFields);
  if (
    state.lastStreamProgressAt !== undefined &&
    now - state.lastStreamProgressAt < MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS
  ) {
    return;
  }
  state.lastStreamProgressAt = now;
  // Streaming providers, local or remote, are expected to produce chunks or
  // heartbeat-style progress. The in-memory freshness clock is refreshed for
  // each chunk, while diagnostic events are throttled so token streams do not
  // spam observers; silent/non-streaming calls remain recoverable after the
  // configured stuck-session timeout.
  emitTrustedDiagnosticEvent({
    type: "run.progress",
    ...progressFields,
  });
}

function modelCallSizeTimingFields(state: ModelCallObservationState): ModelCallSizeTimingFields {
  return {
    ...(state.requestPayloadBytes !== undefined
      ? { requestPayloadBytes: state.requestPayloadBytes }
      : {}),
    ...(state.responseStreamBytes > 0 ? { responseStreamBytes: state.responseStreamBytes } : {}),
    ...(state.timeToFirstByteMs !== undefined
      ? { timeToFirstByteMs: state.timeToFirstByteMs }
      : {}),
  };
}

function modelCallCompletedContent(state: ModelCallObservationState) {
  if (!state.modelContent && !state.outputMessages) {
    return undefined;
  }
  return {
    ...state.modelContent,
    ...(state.outputMessages ? { outputMessages: state.outputMessages } : {}),
  };
}

function modelCallUsageField(state: ModelCallObservationState) {
  return state.usage ? { usage: state.usage } : {};
}

export function createModelObserver(params: {
  streamContext: unknown;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  suppressPluginHooks?: boolean;
  capturePromptStats: boolean;
}): ModelCallObserver {
  const modelContent = streamContextModelContentFields(params.contentCapture, params.streamContext);
  const promptStats = params.capturePromptStats
    ? streamContextModelPromptStats(params.streamContext)
    : undefined;
  const state: ModelCallObservationState = {
    responseStreamBytes: 0,
    modelContent,
    contentCapture: params.contentCapture,
    suppressPluginHooks: params.suppressPluginHooks,
  };
  return {
    state,
    promptStats,
    modelContent,
    assignRequestPayloadBytes(payload) {
      assignRequestPayloadBytes(state, payload);
    },
    observeResponseChunk(startedAt, chunk) {
      observeResponseChunk(state, startedAt, chunk);
    },
    observeFinalResult(eventBase, startedAt, result) {
      observeResultMessageContent(state, startedAt, result);
      // Queue semantic progress beside model lifecycle events so request starts,
      // progress, and the next request retain their authoritative FIFO ordering.
      maybeEmitModelCallSemanticProgress(eventBase, state, result);
    },
    maybeEmitStreamProgress(eventBase) {
      maybeEmitModelCallStreamProgress(eventBase, state);
    },
    sizeTimingFields() {
      return modelCallSizeTimingFields(state);
    },
    completedContent() {
      return modelCallCompletedContent(state);
    },
    usageField() {
      return modelCallUsageField(state);
    },
  };
}
