/**
 * Shared before_tool_call state for adjusted tool params.
 * The adapter and wrapper both consult this map so later execution can use the
 * normalized payload selected by hook processing.
 */
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { AgentToolResult } from "./runtime/index.js";

export const adjustedParamsByToolCallId = new Map<string, unknown>();
const preExecutionBlockedToolCallIds = new Set<string>();
export const structuredReplaySafeToolCallIds = new Set<string>();
const startedToolCallIds = new Set<string>();
const trackedToolCallIds = new Set<string>();
const batchAdmittedToolCallIds = new Set<string>();
const loopWarningsByToolCallId = new Map<string, { warning: string; carried: boolean }>();
const MAX_TRACKED_TOOL_CALLS = 1024;
const MAX_PENDING_LOOP_WARNINGS = 1024;

export function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

/** Consume and remove hook-adjusted params for a completed tool call. */
export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  adjustedParamsByToolCallId.delete(key);
  return params;
}

/** Snapshot hook-adjusted params without consuming later outcome bookkeeping. */
export function peekAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  return params === undefined ? undefined : structuredClone(params);
}

/** Consume whether policy prevented the target tool from starting. */
export function consumePreExecutionBlockedToolCall(toolCallId: string, runId?: string): boolean {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const blocked = preExecutionBlockedToolCallIds.has(key);
  preExecutionBlockedToolCallIds.delete(key);
  return blocked;
}

export function recordPreExecutionBlockedToolCall(toolCallId?: string, runId?: string): void {
  if (!toolCallId) {
    return;
  }
  preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
  while (preExecutionBlockedToolCallIds.size > MAX_TRACKED_TOOL_CALLS) {
    const oldest = preExecutionBlockedToolCallIds.values().next().value;
    if (!oldest) {
      break;
    }
    preExecutionBlockedToolCallIds.delete(oldest);
  }
}

/** Snapshot whether policy prevented execution without stealing cleanup from the tool owner. */
export function peekPreExecutionBlockedToolCall(toolCallId: string, runId?: string): boolean {
  return preExecutionBlockedToolCallIds.has(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Record active wrapper ownership so a racing timeout can inspect the boundary. */
export function recordToolExecutionTracked(toolCallId: string, runId?: string): void {
  trackedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
}

export function recordToolExecutionStarted(toolCallId: string, runId?: string): void {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  trackedToolCallIds.add(key);
  startedToolCallIds.add(key);
}

/** Release execution-boundary evidence when the wrapped invocation settles. */
export function clearTrackedToolExecution(toolCallId: string, runId?: string): void {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  trackedToolCallIds.delete(key);
  startedToolCallIds.delete(key);
}

/**
 * Consume exact in-flight execution state. Undefined means the wrapper already
 * settled or the producer does not participate in OpenClaw boundary tracking.
 */
export function consumeTrackedToolExecutionStarted(
  toolCallId: string,
  runId?: string,
): boolean | undefined {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const tracked = trackedToolCallIds.has(key);
  const started = startedToolCallIds.has(key);
  clearTrackedToolExecution(toolCallId, runId);
  return tracked ? started : undefined;
}

export function recordStructuredReplaySafeToolCall(toolCallId: string, runId?: string): void {
  structuredReplaySafeToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
}

export function consumeStructuredReplaySafeToolCall(toolCallId: string, runId?: string): boolean {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const replaySafe = structuredReplaySafeToolCallIds.has(key);
  structuredReplaySafeToolCallIds.delete(key);
  return replaySafe;
}

/** Mark a call whose loop policy was already admitted with its whole assistant batch. */
export function recordBatchAdmittedToolCall(toolCallId: string, runId?: string): void {
  batchAdmittedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Consume whole-batch loop admission while leaving the remaining tool policies intact. */
export function consumeBatchAdmittedToolCall(toolCallId: string, runId?: string): boolean {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const admitted = batchAdmittedToolCallIds.has(key);
  batchAdmittedToolCallIds.delete(key);
  return admitted;
}

/** Attach bounded loop guidance to the model-visible outcome of an admitted call. */
export function recordLoopWarningForToolCall(
  toolCallId: string,
  warning: string,
  runId?: string,
): void {
  loopWarningsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
    warning,
    carried: false,
  });
  pruneMapToMaxSize(loopWarningsByToolCallId, MAX_PENDING_LOOP_WARNINGS);
}

/** Consume pending guidance when no model-visible result can be emitted. */
export function consumeLoopWarningForToolCall(
  toolCallId: string,
  runId?: string,
): string | undefined {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const warning = loopWarningsByToolCallId.get(key)?.warning;
  loopWarningsByToolCallId.delete(key);
  return warning;
}

function claimLoopWarningForTransport(toolCallId: string, runId?: string): string | undefined {
  const pending = loopWarningsByToolCallId.get(buildAdjustedParamsKey({ runId, toolCallId }));
  if (!pending || pending.carried) {
    return undefined;
  }
  pending.carried = true;
  return pending.warning;
}

function appendWarningTextToToolResult(
  result: AgentToolResult<unknown>,
  warning: string,
): AgentToolResult<unknown> {
  const text = `Tool loop warning: ${warning}`;
  const alreadyPresent = result.content?.some(
    (block) => block.type === "text" && block.text.includes(text),
  );
  if (alreadyPresent) {
    return result;
  }
  return {
    ...result,
    content: [...(result.content ?? []), { type: "text", text }],
  };
}

/** Carry guidance through tool execution while retaining it for final outcome hooks. */
export function carryLoopWarningToToolResult(
  result: AgentToolResult<unknown>,
  toolCallId: string,
  runId?: string,
): AgentToolResult<unknown> {
  const warning = claimLoopWarningForTransport(toolCallId, runId);
  return warning ? appendWarningTextToToolResult(result, warning) : result;
}

export function appendLoopWarningToToolResult(
  result: AgentToolResult<unknown>,
  toolCallId: string,
  runId?: string,
): AgentToolResult<unknown> {
  const warning = consumeLoopWarningForToolCall(toolCallId, runId);
  if (!warning) {
    return result;
  }
  return appendWarningTextToToolResult(result, warning);
}

function appendWarningTextToError(error: unknown, warning: string): unknown {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const message = `${originalMessage}\n\nTool loop warning: ${warning}`;
  if (error instanceof Error) {
    try {
      error.message = message;
      return error;
    } catch {
      const wrapped = new Error(message, { cause: error });
      wrapped.name = error.name;
      return wrapped;
    }
  }
  return new Error(message);
}

/** Carry guidance through a failed call while retaining it for final outcome hooks. */
export function carryLoopWarningToError(
  error: unknown,
  toolCallId: string,
  runId?: string,
): unknown {
  const warning = claimLoopWarningForTransport(toolCallId, runId);
  return warning ? appendWarningTextToError(error, warning) : error;
}

/** Carry warning guidance unless an aborted call cannot emit a model-visible result. */
export function resolveLoopWarningError(
  error: unknown,
  toolCallId: string,
  runId: string | undefined,
  signal?: AbortSignal,
): unknown {
  if (signal?.aborted) {
    consumeLoopWarningForToolCall(toolCallId, runId);
    return error;
  }
  return carryLoopWarningToError(error, toolCallId, runId);
}

/** Release admission and warning state for prepared calls suppressed by steering. */
export function releaseBatchAdmittedToolCalls(
  toolCallIds: readonly string[],
  runId?: string,
): void {
  for (const toolCallId of toolCallIds) {
    const key = buildAdjustedParamsKey({ runId, toolCallId });
    batchAdmittedToolCallIds.delete(key);
    loopWarningsByToolCallId.delete(key);
  }
}

/** Remove unused admission and warning state when an embedded run ends. */
export function clearBatchAdmittedToolCallsForRun(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of batchAdmittedToolCallIds) {
    if (key.startsWith(prefix)) {
      batchAdmittedToolCallIds.delete(key);
    }
  }
  for (const key of loopWarningsByToolCallId.keys()) {
    if (key.startsWith(prefix)) {
      loopWarningsByToolCallId.delete(key);
    }
  }
}

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
  preExecutionBlockedToolCallIds.clear();
  trackedToolCallIds.clear();
  startedToolCallIds.clear();
  structuredReplaySafeToolCallIds.clear();
  batchAdmittedToolCallIds.clear();
  loopWarningsByToolCallId.clear();
}
