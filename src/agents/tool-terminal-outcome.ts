import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  consumeTrackedToolExecutionStarted,
  peekAdjustedParamsForToolCall,
  peekPreExecutionBlockedToolCall,
} from "./agent-tools.before-tool-call.state.js";
import { extractApplyPatchTargets } from "./apply-patch-targets.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { createToolErrorState } from "./tool-error-state.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import type { FileTarget } from "./tool-mutation.js";
import { buildToolMutationState } from "./tool-mutation.js";

function extractPatchFileTargets(
  toolName: string,
  args: Record<string, unknown> | undefined,
): FileTarget[] | undefined {
  if (toolName.trim().toLowerCase() !== "apply_patch") {
    return undefined;
  }
  const targets = extractApplyPatchTargets(args);
  if (targets.some((target) => target.kind === "delete" || target.kind === "move")) {
    return undefined;
  }
  const paths = targets.map((target) => target.path.trim().toLowerCase()).filter(Boolean);
  const uniquePaths = [...new Set(paths)];
  return uniquePaths.length > 0 ? uniquePaths.map<FileTarget>((path) => ({ path })) : undefined;
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
    const fileTargets =
      extractPatchFileTargets(observation.toolName, executedArguments) ??
      (mutation.fileTarget ? [mutation.fileTarget] : undefined);

    let lastToolError: ToolErrorSummary | undefined;
    if (observation.outcome === "failure") {
      const mutatingAction = executionStarted && mutation.mutatingAction;
      const failure: ToolErrorSummary = {
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...observation.failure,
        mutatingAction,
        ...(mutatingAction && mutation.actionFingerprint
          ? { actionFingerprint: mutation.actionFingerprint }
          : {}),
      };
      for (const fileTarget of (mutatingAction ? fileTargets : undefined) ?? [undefined]) {
        lastToolError = errors.recordFailure({
          ...failure,
          ...(fileTarget ? { fileTarget } : {}),
        });
      }
    } else {
      const success = {
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...(mutation.actionFingerprint ? { actionFingerprint: mutation.actionFingerprint } : {}),
      };
      for (const fileTarget of fileTargets ?? [undefined]) {
        lastToolError = errors.recordSuccess({
          ...success,
          ...(fileTarget ? { fileTarget } : {}),
        });
      }
    }

    return {
      ...(lastToolError ? { lastToolError } : {}),
      executionStarted,
      ...(executedArguments ? { executedArguments } : {}),
      sideEffectEvidence: executionStarted && !mutation.replaySafe,
    };
  };
}
