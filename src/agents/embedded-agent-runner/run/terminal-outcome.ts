import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { formatUserFacingAssistantErrorText } from "../../embedded-agent-helpers.js";
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
    // Terminal metadata is displayed directly; keep the provider's raw diagnostics
    // on the original message and project only safe refusal copy.
    assistant:
      params.assistant && isProviderRefusalAssistantError(params.assistant)
        ? {
            ...params.assistant,
            errorMessage: formatUserFacingAssistantErrorText(params.assistant),
          }
        : params.assistant,
    abortSignal: params.abortSignal,
  });
}

export function isEmbeddedRunTerminalTimeout(outcome: AgentRunTerminalOutcome): boolean {
  return classifyAgentRunTerminalOutcome(outcome) === "timeout";
}

export function isEmbeddedRunTerminalAbort(outcome: AgentRunTerminalOutcome): boolean {
  return classifyAgentRunTerminalOutcome(outcome) === "cancellation";
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
