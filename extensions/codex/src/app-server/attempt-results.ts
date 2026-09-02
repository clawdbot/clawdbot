/**
 * Result-shaping helpers for Codex app-server attempt terminal text, replay
 * safety, startup failures, and malformed image errors.
 */
import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexSystemPromptReport } from "./attempt-context.js";
import type { CodexAttemptTimeout } from "./attempt-deadlines.js";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";

/** Joins terminal assistant text blocks into the final attempt answer. */
export function collectTerminalAssistantText(result: EmbeddedRunAttemptResult): string {
  return result.assistantTexts.join("\n\n").trim();
}

/** Reports the owner's deadline without guessing whether native work finished. */
export function buildCodexAppServerPromptTimeoutOutcome(
  timeout: CodexAttemptTimeout | undefined,
): EmbeddedRunAttemptResult["promptTimeoutOutcome"] {
  if (!timeout) {
    return undefined;
  }
  return {
    message:
      timeout.kind === "execution"
        ? "Codex reached the configured execution time limit. Some work may already have been performed; verify the current state before continuing."
        : "Codex finished its turn, but OpenClaw could not finish processing the result. Some work may already have been performed; verify the current state before continuing.",
    replayInvalid: true,
    livenessState: "abandoned",
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
  promptError?: unknown;
  messagesSnapshot: AgentMessage[];
  systemPromptReport: CodexSystemPromptReport;
}): EmbeddedRunAttemptResult {
  return {
    terminal: attemptTerminal.normalize({
      promptError: params.promptError ?? params.message,
      promptErrorSource: "prompt",
    }),
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
