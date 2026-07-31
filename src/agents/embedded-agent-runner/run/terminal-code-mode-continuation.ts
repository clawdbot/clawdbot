import { log } from "../logger.js";
import { RESTART_SAFE_CODE_MODE_CONTINUATION_INSTRUCTION } from "./incomplete-turn.js";
import type { EmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

const MAX_CODE_MODE_ERROR_CONTINUATIONS = 1;
const MAX_CODE_MODE_COMPLETION_CONTINUATIONS = 1;
const MAX_CODE_MODE_VERIFICATION_CONTINUATIONS = 2;

export type EmbeddedRunToolCapableContinuation = {
  kind: "verification" | "completion";
  instruction: string;
  readOnlyToolsScope: "verification" | "run" | null;
};

type CodeModeTerminalContinuationResolution =
  | { action: "retry" }
  | {
      action: "incomplete";
      text: string;
      fallbackSafe: boolean;
      terminalToolPresentation?: string;
    };

export function resolveCodeModeTerminalContinuation(input: {
  retryState: EmbeddedRunTerminalRetryState;
  nextReasoningOnlyRetryInstruction: string | null;
  nextCodeModeErrorRetryInstruction: string | null;
  toolCapableContinuation?: EmbeddedRunToolCapableContinuation | null;
  activateInternalPrompt: (prompt: string, persisted: boolean) => void;
  runId: string;
  sessionId?: string;
  provider: string;
  model: string;
  incompleteTurnFallbackEligible: boolean;
  availableTerminalToolPresentation?: string;
}): CodeModeTerminalContinuationResolution | null {
  if (
    !input.nextReasoningOnlyRetryInstruction &&
    input.nextCodeModeErrorRetryInstruction &&
    input.retryState.codeModeErrorContinuationAttempts < MAX_CODE_MODE_ERROR_CONTINUATIONS
  ) {
    input.retryState.codeModeErrorContinuationAttempts += 1;
    input.activateInternalPrompt(input.nextCodeModeErrorRetryInstruction, false);
    log.warn(
      `side-effect-free Code Mode failure stopped without correction: runId=${input.runId} sessionId=${input.sessionId} ` +
        `provider=${input.provider}/${input.model} — retrying ${input.retryState.codeModeErrorContinuationAttempts}/${MAX_CODE_MODE_ERROR_CONTINUATIONS}`,
    );
    return { action: "retry" };
  }
  if (input.nextReasoningOnlyRetryInstruction || !input.toolCapableContinuation) {
    return null;
  }

  const verificationContinuation = input.toolCapableContinuation.kind === "verification";
  const continuationAttempts = verificationContinuation
    ? input.retryState.codeModeVerificationContinuationAttempts
    : input.retryState.codeModeCompletionContinuationAttempts;
  const maxContinuationAttempts = verificationContinuation
    ? MAX_CODE_MODE_VERIFICATION_CONTINUATIONS
    : MAX_CODE_MODE_COMPLETION_CONTINUATIONS;
  if (continuationAttempts < maxContinuationAttempts) {
    if (verificationContinuation) {
      input.retryState.codeModeVerificationContinuationAttempts += 1;
    } else {
      input.retryState.codeModeCompletionContinuationAttempts += 1;
    }
    if (input.toolCapableContinuation.readOnlyToolsScope === "run") {
      input.retryState.forceReadOnlyToolsForRun = true;
    } else if (input.toolCapableContinuation.readOnlyToolsScope === "verification") {
      input.retryState.forceReadOnlyToolsUntilVerification = true;
    }
    const forceReadOnlyTools =
      input.retryState.forceReadOnlyToolsForRun ||
      input.retryState.forceReadOnlyToolsUntilVerification;
    input.activateInternalPrompt(
      input.retryState.forceReadOnlyToolsForRun
        ? RESTART_SAFE_CODE_MODE_CONTINUATION_INSTRUCTION
        : input.toolCapableContinuation.instruction,
      true,
    );
    log.warn(
      `settled Code Mode work stopped before final verification: runId=${input.runId} sessionId=${input.sessionId} ` +
        `provider=${input.provider}/${input.model} — retrying ${
          verificationContinuation
            ? input.retryState.codeModeVerificationContinuationAttempts
            : input.retryState.codeModeCompletionContinuationAttempts
        }/${maxContinuationAttempts} with ${forceReadOnlyTools ? "read-only" : "normal"} tools`,
    );
    return { action: "retry" };
  }

  const attempts = verificationContinuation
    ? input.retryState.codeModeVerificationContinuationAttempts
    : input.retryState.codeModeCompletionContinuationAttempts;
  const kind = verificationContinuation ? "verification" : "completion";
  log.warn(
    `Code Mode ${kind} retries exhausted: runId=${input.runId} sessionId=${input.sessionId} ` +
      `provider=${input.provider}/${input.model} attempts=${attempts}/${maxContinuationAttempts} — surfacing incomplete-turn error`,
  );
  return verificationContinuation
    ? {
        action: "incomplete",
        text: "⚠️ Agent stopped before completing Code Mode verification. Please inspect the changes and try again.",
        fallbackSafe: false,
      }
    : {
        action: "incomplete",
        text: "⚠️ Agent completed Code Mode work but stopped before producing a final answer. Please inspect the changes and try again.",
        fallbackSafe: input.incompleteTurnFallbackEligible,
        terminalToolPresentation: input.incompleteTurnFallbackEligible
          ? input.availableTerminalToolPresentation
          : undefined,
      };
}
