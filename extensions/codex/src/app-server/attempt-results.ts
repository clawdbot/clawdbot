/**
 * Result-shaping helpers for Codex app-server attempt terminal text, replay
 * safety, startup failures, and malformed image errors.
 */
import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexSystemPromptReport } from "./attempt-context.js";
import type { CodexAttemptTurnWatchTimeoutKind } from "./attempt-turn-watches.js";

const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE =
  "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.";
const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE =
  "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.";
const CODEX_APP_SERVER_TERMINAL_IDLE_USER_MESSAGE =
  "Codex stopped responding: no activity arrived for the turn's liveness window, so the turn was ended and the connection was replaced. Retry to continue on a fresh session.";

/** Joins terminal assistant text blocks into the final attempt answer. */
export function collectTerminalAssistantText(result: EmbeddedRunAttemptResult): string {
  return result.assistantTexts.join("\n\n").trim();
}

/**
 * Builds the user-facing timeout outcome when Codex stops without a terminal
 * turn event.
 */
export function buildCodexAppServerPromptTimeoutOutcome(params: {
  result: EmbeddedRunAttemptResult;
  turnCompletionIdleTimedOut: boolean;
  turnWatchTimeoutKind?: CodexAttemptTurnWatchTimeoutKind;
}): EmbeddedRunAttemptResult["promptTimeoutOutcome"] {
  if (!params.turnCompletionIdleTimedOut) {
    return undefined;
  }
  // Terminal-idle kills are dead-client events, not slow turns: the generic
  // "increase agents.defaults.timeoutSeconds" advice would be wrong because
  // that watch deliberately ignores the agent budget. Salvaged assistant
  // output still wins over any timeout notice.
  if (params.turnWatchTimeoutKind === "terminal") {
    if (collectTerminalAssistantText(params.result)) {
      return undefined;
    }
    const terminalReplayBlockedReason = resolveCodexAppServerReplayBlockedReason(params.result);
    return {
      message: CODEX_APP_SERVER_TERMINAL_IDLE_USER_MESSAGE,
      ...(terminalReplayBlockedReason
        ? {
            replayInvalid: true,
            livenessState: "abandoned" as const,
          }
        : {}),
    };
  }
  if (params.turnWatchTimeoutKind !== undefined && params.turnWatchTimeoutKind !== "completion") {
    return undefined;
  }
  const replayBlockedReason = resolveCodexAppServerReplayBlockedReason(params.result);
  const completionIdleTimeoutHadPotentialSideEffects =
    replayBlockedReason === "tool_activity" ||
    replayBlockedReason === "potential_side_effect" ||
    replayBlockedReason === "active_item";
  return {
    message: completionIdleTimeoutHadPotentialSideEffects
      ? CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE
      : CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE,
    ...(replayBlockedReason
      ? {
          replayInvalid: true,
          livenessState: "abandoned" as const,
        }
      : {}),
  };
}

/** Explains why an incomplete app-server turn cannot be safely replayed. */
export function resolveCodexAppServerReplayBlockedReason(
  result: EmbeddedRunAttemptResult,
):
  | NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>["replayBlockedReason"]
  | undefined {
  if (result.replayMetadata.hadPotentialSideEffects) {
    return "potential_side_effect";
  }
  if (result.assistantTexts.some((text) => text.trim().length > 0)) {
    return "assistant_output";
  }
  if (
    result.toolMetas.length > 0 ||
    result.clientToolCalls ||
    result.lastToolError ||
    result.didSendDeterministicApprovalPrompt
  ) {
    return "tool_activity";
  }
  if (result.itemLifecycle.startedCount > 0 || result.itemLifecycle.activeCount > 0) {
    return "active_item";
  }
  return undefined;
}

/** Builds an attempt result for failures before the app-server turn starts. */
export function buildCodexTurnStartFailureResult(params: {
  params: EmbeddedRunAttemptParams;
  message: string;
  messagesSnapshot: AgentMessage[];
  systemPromptReport: CodexSystemPromptReport;
}): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: params.message,
    promptErrorSource: "prompt",
    sessionIdUsed: params.params.sessionId,
    messagesSnapshot: params.messagesSnapshot,
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {
      hadPotentialSideEffects: false,
      replaySafe: true,
    },
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    systemPromptReport: params.systemPromptReport,
  };
}

/** Detects app-server errors caused by invalid image payload data. */
export function isInvalidCodexImagePayloadError(message: unknown): boolean {
  if (typeof message !== "string" || !message.trim()) {
    return false;
  }
  const normalizedMessage = message.replace(/[_-]+/gu, " ");
  return (
    /\b(?:invalid|malformed)\b[\s\S]{0,120}\b(?:image|image url|base64)\b/iu.test(
      normalizedMessage,
    ) ||
    /\b(?:image|image url|base64)\b[\s\S]{0,120}\b(?:invalid|malformed)\b/iu.test(normalizedMessage)
  );
}
