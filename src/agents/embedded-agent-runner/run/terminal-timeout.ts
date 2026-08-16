import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { hasMessagingToolDeliveryEvidence } from "../delivery-evidence.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import { resolveRunLivenessState } from "./incomplete-turn-resolution.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalTimeout,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import { copyAttemptDeliveryState } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function resolveEmbeddedRunTerminalTimeout(input: {
  timedOutDuringPrompt: boolean;
  hasSuccessfulFinalAssistantAfterPromptTimeout: boolean;
  shouldSurfaceCodexCompletionTimeout: boolean;
  attempt: EmbeddedRunAttemptResult;
  hasPartialAssistantTextAfterPromptTimeout: boolean;
  payloads: EmbeddedAgentRunResult["payloads"];
  payloadsWithToolMedia: EmbeddedAgentRunResult["payloads"];
  terminalState: EmbeddedRunTerminalState;
  resolveReplayInvalid: (incompleteTurnText?: string | null) => boolean;
  setTerminalLifecycleMeta: NonNullable<EmbeddedRunAttemptResult["setTerminalLifecycleMeta"]>;
  startedAtMs: number;
  agentMeta: EmbeddedAgentMeta;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  attemptToolSummary: EmbeddedAgentRunResult["meta"]["toolSummary"];
  failureSignal: EmbeddedAgentRunResult["meta"]["failureSignal"];
}): EmbeddedAgentRunResult | undefined {
  if (
    !input.timedOutDuringPrompt ||
    input.hasSuccessfulFinalAssistantAfterPromptTimeout ||
    (!input.shouldSurfaceCodexCompletionTimeout && hasMessagingToolDeliveryEvidence(input.attempt))
  ) {
    return undefined;
  }
  const { idleTimedOut } = projectAgentRunAttemptTerminal(input.attempt.terminal);
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  const defaultTimeoutText = idleTimedOut
    ? "The model did not produce a response before the model idle timeout. " +
      "Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. " +
      "If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run."
    : "Request timed out before a response was generated. " +
      "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
  const timeoutText = input.attempt.promptTimeoutOutcome?.message?.trim() || defaultTimeoutText;
  const replayInvalid =
    input.attempt.promptTimeoutOutcome?.replayInvalid ?? input.resolveReplayInvalid(null);
  const livenessState =
    input.attempt.promptTimeoutOutcome?.livenessState ??
    resolveRunLivenessState({
      payloadCount: input.hasPartialAssistantTextAfterPromptTimeout
        ? 0
        : (input.payloads?.length ?? 0),
      aborted: terminalAborted,
      timedOut: terminalTimedOut,
      attempt: input.attempt,
      incompleteTurnText: null,
    });
  const timeoutPhase =
    input.attempt.promptTimeoutOutcome?.timeoutPhase ?? input.terminalState.outcome.timeoutPhase;
  const providerStarted =
    input.attempt.promptTimeoutOutcome?.providerStarted ??
    input.terminalState.outcome.providerStarted;
  const timeoutAttribution = {
    ...(timeoutPhase ? { timeoutPhase } : {}),
    ...(typeof providerStarted === "boolean" ? { providerStarted } : {}),
  };
  input.setTerminalLifecycleMeta({ replayInvalid, livenessState, ...timeoutAttribution });
  return {
    payloads: [
      ...(input.hasPartialAssistantTextAfterPromptTimeout ? [] : input.payloadsWithToolMedia || []),
      { text: timeoutText, isError: true },
    ],
    meta: {
      durationMs: Date.now() - input.startedAtMs,
      agentMeta: input.agentMeta,
      aborted: terminalAborted,
      systemPromptReport: input.attempt.systemPromptReport,
      finalPromptText: input.attempt.finalPromptText,
      finalAssistantVisibleText: input.finalAssistantVisibleText,
      finalAssistantRawText: input.finalAssistantRawText,
      replayInvalid,
      livenessState,
      ...timeoutAttribution,
      ...(input.shouldSurfaceCodexCompletionTimeout
        ? {
            error: {
              kind: "incomplete_turn" as const,
              message: timeoutText,
              fallbackSafe: false,
            },
          }
        : {}),
      toolSummary: input.attemptToolSummary,
      ...(input.failureSignal ? { failureSignal: input.failureSignal } : {}),
      agentHarnessResultClassification: input.attempt.agentHarnessResultClassification,
    },
    ...copyAttemptDeliveryState(input.attempt),
  };
}
