/**
 * Shared before_tool_call state for adjusted tool params.
 * The adapter and wrapper both consult this map so later execution can use the
 * normalized payload selected by hook processing.
 */
export const adjustedParamsByToolCallId = new Map<string, unknown>();
export const preExecutionBlockedToolCallIds = new Set<string>();
export const structuredReplaySafeToolCallIds = new Set<string>();
const startedToolCallIds = new Set<string>();
const trackedToolCallIds = new Set<string>();

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

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
  preExecutionBlockedToolCallIds.clear();
  trackedToolCallIds.clear();
  startedToolCallIds.clear();
  structuredReplaySafeToolCallIds.clear();
}
