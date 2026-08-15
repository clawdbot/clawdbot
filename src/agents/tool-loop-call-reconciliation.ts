import { normalizeOptionalString as normalizeRunId } from "@openclaw/normalization-core/string-coerce";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { getToolArgumentChurnStreak } from "./tool-loop-argument-churn.js";
import { hashToolCall } from "./tool-loop-detection.js";
import { hashWriteMutationTarget } from "./tool-loop-write-outcome.js";

/**
 * Rebind the pending admission record to the arguments that will actually
 * execute after trusted/plugin policy rewrites, then re-evaluate churn against
 * the completed history that preceded that call.
 */
export function reconcileToolCallExecutionParams(
  state: SessionState,
  params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    runId?: string;
    cwd?: string;
    warningThreshold: number;
  },
): ReturnType<typeof getToolArgumentChurnStreak> & {
  active: boolean;
  matchedPendingCall: boolean;
  executionParamsChanged: boolean;
} {
  const history = state.toolCallHistory;
  if (!history) {
    return {
      active: false,
      count: 0,
      variantCount: 0,
      matchedPendingCall: false,
      executionParamsChanged: false,
    };
  }

  const runId = normalizeRunId(params.runId);
  const argsHash = hashToolCall(params.toolName, params.toolParams);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const call = history[index];
    if (!call || normalizeRunId(call.runId) !== runId) {
      continue;
    }
    if (params.toolCallId && call.toolCallId !== params.toolCallId) {
      continue;
    }
    if (
      call.toolName !== params.toolName ||
      call.resultHash !== undefined ||
      call.outcomeKind !== undefined
    ) {
      continue;
    }

    const executionParamsChanged = call.argsHash !== argsHash;
    call.argsHash = argsHash;
    call.mutationTargetHash = hashWriteMutationTarget(
      params.toolName,
      params.toolParams,
      params.cwd,
    );
    const scopedHistory = history
      .slice(0, index)
      .filter((record) => normalizeRunId(record.runId) === runId);
    const churn = getToolArgumentChurnStreak(scopedHistory, call);
    return {
      active: churn.count >= params.warningThreshold,
      matchedPendingCall: true,
      executionParamsChanged,
      ...churn,
    };
  }

  return {
    active: false,
    count: 0,
    variantCount: 0,
    matchedPendingCall: false,
    executionParamsChanged: false,
  };
}
