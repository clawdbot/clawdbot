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
const batchAdmittedToolCallIds = new Set<string>();

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

// Same bound as the wrapper's other adjusted-param/replay-safe tracking sets
// (MAX_TRACKED_ADJUSTED_PARAMS in agent-tools.before-tool-call.wrapper.ts) --
// kept as its own local constant rather than imported to avoid a state<->wrapper
// import cycle, since this module is otherwise import-free by design.
const MAX_PRE_EXECUTION_BLOCKED_IDS = 1024;

/**
 * Mark a call that never actually attempted its mutating work -- either a
 * generic before_tool_call hook veto (see buildBlockedToolResult), or a
 * tool's own internal validation rejecting the call before any real
 * execution (e.g. sessions_spawn's target-policy check). Both cases mean
 * the same thing to the run's completion classification: nothing was
 * mutated, so this call must not taint the turn as a failed mutating
 * action (#<incident>: a rejected sessions_spawn(agentId: "job-search")
 * call permanently marked an otherwise-successful cron run as
 * agent-tool-failure, even though the model recovered and completed the
 * real task).
 */
export function recordPreExecutionBlockedToolCall(toolCallId?: string, runId?: string): void {
  if (!toolCallId) {
    return;
  }
  preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
  while (preExecutionBlockedToolCallIds.size > MAX_PRE_EXECUTION_BLOCKED_IDS) {
    const oldest = preExecutionBlockedToolCallIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    preExecutionBlockedToolCallIds.delete(oldest);
  }
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

/** Release exact batch-admission markers for prepared calls suppressed by steering. */
export function releaseBatchAdmittedToolCalls(
  toolCallIds: readonly string[],
  runId?: string,
): void {
  for (const toolCallId of toolCallIds) {
    batchAdmittedToolCallIds.delete(buildAdjustedParamsKey({ runId, toolCallId }));
  }
}

/** Remove unused batch-admission markers when their embedded run ends. */
export function clearBatchAdmittedToolCallsForRun(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of batchAdmittedToolCallIds) {
    if (key.startsWith(prefix)) {
      batchAdmittedToolCallIds.delete(key);
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
}
