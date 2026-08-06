import {
  buildAgentRunTerminalOutcomeFromAttempt,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedRunAttemptTerminalInput = Pick<
  EmbeddedRunAttemptResult,
  "terminal" | "promptTimeoutOutcome"
>;

export type EmbeddedRunTerminalState = {
  outcome: AgentRunTerminalOutcome;
  signalOwnedInterruption: boolean;
};

/** Projects private attempt metadata into the canonical agent terminal outcome. */
export function resolveEmbeddedRunAttemptTerminalOutcome(params: {
  attempt: EmbeddedRunAttemptTerminalInput;
  assistant: EmbeddedRunAttemptResult["lastAssistant"];
  abortSignal?: AbortSignal;
}): AgentRunTerminalOutcome {
  return buildAgentRunTerminalOutcomeFromAttempt({
    terminal: params.attempt.terminal,
    promptTimeoutOutcome: params.attempt.promptTimeoutOutcome,
    assistant: params.assistant,
    abortSignal: params.abortSignal,
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

/** Captures signal ownership with the outcome before async recovery can change the signal. */
export function resolveEmbeddedRunAttemptTerminalState(
  params: Parameters<typeof resolveEmbeddedRunAttemptTerminalOutcome>[0],
): EmbeddedRunTerminalState {
  const outcome = resolveEmbeddedRunAttemptTerminalOutcome(params);
  return {
    outcome,
    signalOwnedInterruption:
      isEmbeddedRunTerminalInterrupted(outcome) && params.abortSignal?.aborted === true,
  };
}
