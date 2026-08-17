import {
  classifyAgentHarnessTerminalOutcome,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  attemptTerminal,
  type AttemptFailureSource,
  type EmbeddedRunAttemptResult,
} from "./attempt-terminal.js";
import type { CodexAssistantProjection } from "./event-projector-assistant.js";
import type { CodexGeneratedMediaProjection } from "./event-projector-media.js";
import type { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import type { CodexReasoningProjection } from "./event-projector-reasoning.js";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";
import type { CodexToolProgressProjection } from "./event-projector-tool-progress.js";
import type { CodexToolTranscriptProjection } from "./event-projector-tool-transcript.js";
import type { CodexResponseCompletionProjection } from "./event-projector-usage.js";
import type { CodexTurn } from "./protocol.js";

export type CodexAppServerToolTelemetry = {
  didSendViaMessagingTool: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
} & Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">;

type CodexAttemptResultInput = {
  runParams: EmbeddedRunAttemptParams;
  turnId: string;
  upstreamUserText: string | undefined;
  completedTurn: CodexTurn | undefined;
  promptError: unknown;
  promptErrorSource: AttemptFailureSource | null;
  synthesizedMissingToolResultError: string | null;
  recordSynthesizedMissingToolResultError: (error: string) => void;
  aborted: boolean;
  tokenUsage: EmbeddedRunAttemptResult["attemptUsage"];
  contextTokens: number | undefined;
  completedCompactionCount: number;
  activeItemCount: number;
  completedItemCount: number;
  guardianReviewCount: number;
  toolTelemetry: CodexAppServerToolTelemetry;
  yieldDetected: boolean | undefined;
  nativeToolLifecycleProjection: Pick<CodexNativeToolLifecycleProjector, "finalizeActive">;
  assistantProjection: Pick<
    CodexAssistantProjection,
    | "collectAssistantTexts"
    | "collectCommentaryMessages"
    | "createAssistantMessage"
    | "createAssistantMirrorMessage"
    | "createCurrentAttemptAssistantMessage"
    | "hasAssistantItemTextForSynthesis"
  >;
  reasoningProjection: Pick<CodexReasoningProjection, "planText" | "reasoningText">;
  responseCompletions: Pick<CodexResponseCompletionProjection, "modelIterations" | "usage">;
  toolTranscriptProjection: Pick<
    CodexToolTranscriptProjection,
    "synthesizeMissingToolResults" | "transcriptMessages"
  >;
  toolProgressProjection: Pick<
    CodexToolProgressProjection,
    "hasPotentialSideEffects" | "lastToolError" | "toolMetas"
  >;
  generatedMediaProjection: Pick<
    CodexGeneratedMediaProjection,
    "buildHostOwnedMediaUrls" | "buildToolMediaUrls" | "hasGeneratedMedia"
  >;
};

export function buildCodexAttemptResult(
  input: CodexAttemptResultInput,
): EmbeddedRunAttemptResult & { terminalTurnId: string } {
  // Result construction runs after the notification queue drains. Close any
  // tool lacking a terminal item so audit consumers never retain an open action.
  input.nativeToolLifecycleProjection.finalizeActive();
  const assistantTexts = input.assistantProjection.collectAssistantTexts();
  const commentaryMessages = input.assistantProjection.collectCommentaryMessages();
  const reasoningText = input.reasoningProjection.reasoningText();
  const planText = input.reasoningProjection.planText();
  // A terminal timeout must not publish exact usage, but the timeout watcher
  // can still recover a completed assistant. Keep the snapshot masked until
  // recovery clears the abort instead of destroying it in markTimedOut().
  const unavailableThreadUsage = input.tokenUsage
    ? { ...input.tokenUsage, contextUsage: { state: "unavailable" } as const }
    : undefined;
  const completedUsage =
    input.responseCompletions.usage ??
    (input.responseCompletions.modelIterations > 0 ? unavailableThreadUsage : input.tokenUsage);
  const projectedUsage = input.aborted ? unavailableThreadUsage : completedUsage;
  const hasAssistantItemText = input.assistantProjection.hasAssistantItemTextForSynthesis();
  const legacyFailClosed =
    !input.completedTurn || input.completedTurn.status !== "completed" || hasAssistantItemText;
  const hasDeliverableAssistantOnCompletedTurn =
    input.completedTurn?.status === "completed" &&
    assistantTexts.some((text) => text.trim().length > 0);
  const synthesizedMissingToolResultError =
    input.toolTranscriptProjection.synthesizeMissingToolResults({
      synthesize: legacyFailClosed,
      // Preserve audit synthesis on every path, but completed answers must not
      // promote bookkeeping gaps into user-visible terminal failure evidence.
      terminalDisposition: input.aborted
        ? "tool_error"
        : hasDeliverableAssistantOnCompletedTurn
          ? "diagnostic_only"
          : "prompt_error",
    });
  const storedMissingToolResultError =
    synthesizedMissingToolResultError ?? input.synthesizedMissingToolResultError;
  let promptErrorSource = input.promptErrorSource;
  if (synthesizedMissingToolResultError) {
    input.recordSynthesizedMissingToolResultError(synthesizedMissingToolResultError);
    promptErrorSource = promptErrorSource ?? "prompt";
  }
  const assistantMessageOptions = {
    tokenUsage: projectedUsage,
    aborted: input.aborted,
    promptError: input.promptError,
  };
  const lastAssistant = assistantTexts.length
    ? input.assistantProjection.createAssistantMessage(
        assistantTexts.join("\n\n"),
        assistantMessageOptions,
      )
    : undefined;
  const currentAttemptAssistant =
    input.assistantProjection.createCurrentAttemptAssistantMessage(assistantMessageOptions);
  // Each snapshot entry is tagged with a stable mirror identity of the
  // shape `${turnId}:${kind}`. The mirror's idempotency key is derived
  // from this identity rather than from snapshot position or content
  // hash, so:
  //   - Re-mirror of the same turn (retry) → same identity → no-op.
  //   - Re-emit of a prior turn's entry into a later turn's snapshot
  //     (the cross-turn drift mode named in #77012) → original identity
  //     is preserved → on-disk key still matches → also a no-op.
  //   - Two distinct turns where the user repeats verbatim content →
  //     distinct turnIds → distinct identities → both kept.
  // Codex owns the canonical thread. These mirror records keep enough local
  // context for OpenClaw history, search, and future harness switching.
  const messagesSnapshot = buildCodexMessagesSnapshot({
    runParams: input.runParams,
    turnId: input.turnId,
    upstreamUserText: input.upstreamUserText,
    reasoningText,
    planText,
    commentaryMessages,
    toolMessages: input.toolTranscriptProjection.transcriptMessages,
    lastAssistant,
    createAssistantMirrorMessage: (title, text) =>
      input.assistantProjection.createAssistantMirrorMessage(title, text),
  });
  const turnFailed = input.completedTurn?.status === "failed";
  const promptError =
    input.promptError ??
    storedMissingToolResultError ??
    (turnFailed ? (input.completedTurn?.error?.message ?? "codex app-server turn failed") : null);
  const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
    assistantTexts,
    reasoningText,
    planText,
    promptError,
    turnCompleted: Boolean(input.completedTurn),
  });
  const toolMetas = input.toolProgressProjection.toolMetas;
  const hadPotentialSideEffects =
    input.toolTelemetry.didSendViaMessagingTool ||
    Boolean(
      input.toolTelemetry.successfulCronAdds || input.toolTelemetry.acceptedSessionSpawns?.length,
    ) ||
    input.generatedMediaProjection.hasGeneratedMedia() ||
    input.toolProgressProjection.hasPotentialSideEffects;
  return {
    terminal: attemptTerminal.normalize({
      aborted: input.aborted,
      promptError,
      promptErrorSource: promptError ? promptErrorSource || "prompt" : null,
    }),
    sessionIdUsed: input.runParams.sessionId,
    terminalTurnId: input.turnId,
    ...(agentHarnessResultClassification ? { agentHarnessResultClassification } : {}),
    bootstrapPromptWarningSignaturesSeen: input.runParams.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: input.runParams.bootstrapPromptWarningSignature,
    ...(input.responseCompletions.modelIterations > 0
      ? { modelIterations: input.responseCompletions.modelIterations }
      : {}),
    messagesSnapshot,
    assistantTexts,
    toolMetas,
    lastAssistant,
    currentAttemptAssistant,
    ...(input.toolProgressProjection.lastToolError
      ? { lastToolError: input.toolProgressProjection.lastToolError }
      : {}),
    didSendViaMessagingTool: input.toolTelemetry.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool:
      input.toolTelemetry.didDeliverSourceReplyViaMessageTool === true,
    messagingToolSentTexts: input.toolTelemetry.messagingToolSentTexts,
    messagingToolSentMediaUrls: input.toolTelemetry.messagingToolSentMediaUrls,
    messagingToolSentTargets: input.toolTelemetry.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: input.toolTelemetry.messagingToolSourceReplyPayloads ?? [],
    heartbeatToolResponse: input.toolTelemetry.heartbeatToolResponse,
    toolMediaUrls: input.generatedMediaProjection.buildToolMediaUrls(input.toolTelemetry),
    hostOwnedToolMediaUrls: input.generatedMediaProjection.buildHostOwnedMediaUrls(
      input.toolTelemetry,
    ),
    toolAudioAsVoice: input.toolTelemetry.toolAudioAsVoice,
    successfulCronAdds: input.toolTelemetry.successfulCronAdds,
    acceptedSessionSpawns: input.toolTelemetry.acceptedSessionSpawns,
    cloudCodeAssistFormatError: false,
    contextTokens: input.contextTokens,
    attemptUsage: projectedUsage,
    ...(input.completedCompactionCount > 0
      ? { compactionCount: input.completedCompactionCount }
      : {}),
    replayMetadata: {
      hadPotentialSideEffects,
      replaySafe: !hadPotentialSideEffects,
    },
    itemLifecycle: {
      startedCount: input.activeItemCount + input.completedItemCount,
      completedCount: input.completedItemCount,
      activeCount: input.activeItemCount,
    },
    yieldDetected: input.yieldDetected || false,
    didSendDeterministicApprovalPrompt: input.guardianReviewCount > 0 ? false : undefined,
  };
}
