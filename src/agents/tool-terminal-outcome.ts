import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  consumeTrackedToolExecutionStarted,
  peekAdjustedParamsForToolCall,
  peekPreExecutionBlockedToolCall,
} from "./agent-tools.before-tool-call.state.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { buildToolEffectReceipt, readToolEffectReceipt } from "./tool-effect-receipt.js";
import { createToolErrorState } from "./tool-error-state.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import { buildToolMutationState } from "./tool-mutation.js";

/** Build one attempt-scoped facts-in/state-out terminal observer for every harness. */
export function createToolTerminalObserver(
  runId: string,
): NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]> {
  const errors = createToolErrorState();

  return (observation) => {
    const effectReceipt = readToolEffectReceipt(observation.result);
    const trackedExecutionStarted = observation.toolCallId
      ? consumeTrackedToolExecutionStarted(observation.toolCallId, runId)
      : undefined;
    const trackedArguments = observation.toolCallId
      ? peekAdjustedParamsForToolCall(observation.toolCallId, runId)
      : undefined;
    const executionPrevented = observation.toolCallId
      ? peekPreExecutionBlockedToolCall(observation.toolCallId, runId)
      : false;
    const executionStarted =
      (trackedExecutionStarted ?? observation.executionStarted ?? true) &&
      !executionPrevented &&
      effectReceipt?.state !== "not_started";
    const executedArguments = asRecord(trackedArguments) ?? asRecord(observation.arguments);
    const mutation = observation.ownerMutation
      ? buildToolMutationState(observation.toolName, executedArguments, {
          ownerKey: observation.ownerMutation.ownerKey,
        })
      : (observation.nativeMutation ??
        buildToolMutationState(observation.toolName, executedArguments));
    const replaySafe = observation.replaySafe ?? mutation.replaySafe;
    let lastToolError: ToolErrorSummary | undefined;
    if (observation.outcome === "failure") {
      const mutatingAction = executionStarted && mutation.mutatingAction;
      const failure: ToolErrorSummary = {
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...observation.failure,
        executionStarted,
        mutatingAction,
      };
      lastToolError = errors.recordFailure(failure).lastToolError;
    } else {
      lastToolError = errors.recordSuccess(observation.toolName).lastToolError;
    }

    return {
      ...(lastToolError ? { lastToolError } : {}),
      executionStarted,
      ...(executedArguments ? { executedArguments } : {}),
      sideEffectEvidence: executionStarted && !replaySafe,
      effectReceipt:
        effectReceipt ??
        buildToolEffectReceipt({
          executionStarted,
          mutatingAction: mutation.mutatingAction,
          replaySafe,
          outcome: observation.outcome,
        }),
    };
  };
}
