import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../../run-termination.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedRunAttemptTerminalInput = Pick<
  EmbeddedRunAttemptResult,
  | "aborted"
  | "idleTimedOut"
  | "promptError"
  | "promptTimeoutOutcome"
  | "timedOut"
  | "timedOutDuringCompaction"
  | "timedOutDuringToolExecution"
>;

function hasRestartAbortReason(value: unknown): boolean {
  let candidate = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isAgentRunRestartAbortReason(candidate)) {
      return true;
    }
    if (!(candidate instanceof Error)) {
      return false;
    }
    try {
      if (candidate.cause === undefined) {
        return false;
      }
      candidate = candidate.cause;
    } catch {
      return false;
    }
  }
  return false;
}

/** Projects private attempt metadata into the canonical agent terminal outcome. */
export function resolveEmbeddedRunAttemptTerminalOutcome(params: {
  attempt: EmbeddedRunAttemptTerminalInput;
  assistant: EmbeddedRunAttemptResult["lastAssistant"];
  abortSignal?: AbortSignal;
}): AgentRunTerminalOutcome {
  const { attempt } = params;
  const abortFields = resolveAgentRunAbortLifecycleFields(params.abortSignal);
  const attemptTimedOut = attempt.timedOut || attempt.idleTimedOut;
  const timedOut = attemptTimedOut || abortFields.stopReason === "timeout";
  const timedOutDuringPrompt =
    attemptTimedOut &&
    !attempt.timedOutDuringCompaction &&
    attempt.timedOutDuringToolExecution !== true;
  const timeoutPhase =
    attempt.promptTimeoutOutcome?.timeoutPhase ?? (timedOutDuringPrompt ? "provider" : undefined);
  const providerStarted =
    attempt.promptTimeoutOutcome?.providerStarted ?? (timedOutDuringPrompt ? true : undefined);
  // Internal queue restarts are wrapped by the attempt's abortable prompt race,
  // so promptError must preserve restart ownership when no parent signal exists.
  const restartAborted = hasRestartAbortReason(attempt.promptError);
  const assistantStopReason = attempt.promptError ? undefined : params.assistant?.stopReason;
  const unattributedAttemptTimeout =
    attemptTimedOut && timeoutPhase === undefined && providerStarted !== true;
  const stopReason = unattributedAttemptTimeout
    ? undefined
    : (abortFields.stopReason ??
      (restartAborted ? AGENT_RUN_RESTART_ABORT_STOP_REASON : undefined) ??
      (!timedOut && attempt.aborted ? "aborted" : undefined) ??
      (!timedOut ? assistantStopReason : undefined));
  const status = timedOut
    ? "timeout"
    : abortFields.aborted ||
        attempt.aborted ||
        attempt.promptError ||
        assistantStopReason === "error"
      ? "error"
      : "ok";

  return buildAgentRunTerminalOutcome({
    status,
    error: attempt.promptError ?? params.assistant?.errorMessage,
    stopReason,
    livenessState: attempt.promptTimeoutOutcome?.livenessState,
    timeoutPhase,
    providerStarted,
  });
}

export function isEmbeddedRunTerminalTimeout(outcome: AgentRunTerminalOutcome): boolean {
  return outcome.reason === "hard_timeout" || outcome.reason === "timed_out";
}

export function isEmbeddedRunTerminalAbort(outcome: AgentRunTerminalOutcome): boolean {
  return outcome.reason === "aborted" || outcome.reason === "cancelled";
}

export function isEmbeddedRunTerminalInterrupted(outcome: AgentRunTerminalOutcome): boolean {
  return isEmbeddedRunTerminalTimeout(outcome) || isEmbeddedRunTerminalAbort(outcome);
}
