import {
  consumeTrackedToolExecutionStarted,
  peekAdjustedParamsForToolCall,
  peekPreExecutionBlockedToolCall,
} from "./agent-tools.before-tool-call.state.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { createToolErrorState } from "./tool-error-state.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import { buildToolMutationState } from "./tool-mutation.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Build one attempt-scoped facts-in/state-out terminal observer for every harness. */
export function createToolTerminalObserver(
  runId: string,
): NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]> {
  const errors = createToolErrorState();

  return (observation) => {
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
      (trackedExecutionStarted ?? observation.executionStarted ?? true) && !executionPrevented;
    const executedArguments = asRecord(trackedArguments) ?? asRecord(observation.arguments);
    const mutation =
      observation.nativeMutation ??
      buildToolMutationState(observation.toolName, executedArguments, observation.meta);

    let lastToolError: ToolErrorSummary | undefined;
    if (observation.outcome === "failure") {
      const mutatingAction = executionStarted && mutation.mutatingAction;
      lastToolError = errors.recordFailure({
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...observation.failure,
        mutatingAction,
        ...(mutatingAction && mutation.actionFingerprint
          ? { actionFingerprint: mutation.actionFingerprint }
          : {}),
        ...(mutatingAction && mutation.fileTarget ? { fileTarget: mutation.fileTarget } : {}),
      });
    } else {
      lastToolError = errors.recordSuccess({
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...(mutation.actionFingerprint ? { actionFingerprint: mutation.actionFingerprint } : {}),
        ...(mutation.fileTarget ? { fileTarget: mutation.fileTarget } : {}),
      });
    }

    return {
      ...(lastToolError ? { lastToolError } : {}),
      executionStarted,
      ...(executedArguments ? { executedArguments } : {}),
      sideEffectEvidence: executionStarted && !mutation.replaySafe,
    };
  };
}
