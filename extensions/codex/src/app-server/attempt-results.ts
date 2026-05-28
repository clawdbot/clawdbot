import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexSystemPromptReport } from "./attempt-context.js";

const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE =
  "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.";
const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE =
  "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.";

export function collectTerminalAssistantText(result: EmbeddedRunAttemptResult): string {
  return result.assistantTexts.join("\n\n").trim();
}

export function hasCodexAppServerPotentialSideEffectEvidence(
  result: EmbeddedRunAttemptResult,
): boolean {
  return result.replayMetadata.hadPotentialSideEffects;
}

export function buildCodexAppServerPromptTimeoutOutcome(params: {
  result: EmbeddedRunAttemptResult;
  turnCompletionIdleTimedOut: boolean;
}): EmbeddedRunAttemptResult["promptTimeoutOutcome"] {
  const completionIdleTimeoutHadPotentialSideEffects = hasCodexAppServerPotentialSideEffectEvidence(
    params.result,
  );
  if (
    !params.turnCompletionIdleTimedOut ||
    (params.result.itemLifecycle.completedCount === 0 &&
      !completionIdleTimeoutHadPotentialSideEffects)
  ) {
    return undefined;
  }
  return {
    message: completionIdleTimeoutHadPotentialSideEffects
      ? CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE
      : CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE,
    ...(completionIdleTimeoutHadPotentialSideEffects
      ? {
          replayInvalid: true,
          livenessState: "abandoned" as const,
        }
      : {}),
  };
}

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
