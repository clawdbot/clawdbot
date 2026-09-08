import {
  classifyAgentHarnessTerminalOutcome,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexTtsProvenanceTransfer } from "openclaw/plugin-sdk/codex-mcp-projection";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { CodexAssistantProjection } from "./event-projector-assistant.js";
import { CodexAsyncDeliveryProjection } from "./event-projector-async-delivery.js";
import { CodexProjectionDiagnostics } from "./event-projector-diagnostics.js";
import { CodexEventProjection, emitCodexAgentEvent } from "./event-projector-events.js";
import { CodexGeneratedMediaProjection } from "./event-projector-media.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import type { CodexAppServerEventProjectorOptions } from "./event-projector-options.js";
import { CodexReasoningProjection } from "./event-projector-reasoning.js";
import { CodexProjectionSettlement } from "./event-projector-settlement.js";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";
import { CodexTerminalFailureProjection } from "./event-projector-terminal-failure.js";
import { CodexToolProgressProjection } from "./event-projector-tool-progress.js";
import { CodexToolTranscriptProjection } from "./event-projector-tool-transcript.js";
import { CodexUsageProjection } from "./event-projector-usage.js";
import type { CodexTurn } from "./protocol.js";
import { CodexTranscriptCheckpoint } from "./transcript-checkpoint.js";

export type CodexAppServerToolTelemetry = {
  didSendViaMessagingTool: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  sourceReplyDelivered?: true;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAutoDeliveryMediaUrls?: string[];
  coreTtsToolResults?: object[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
} & Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">;

/** Owns per-turn projection state and builds results from the same state. */
export abstract class CodexTurnProjection {
  readonly transcriptCheckpoint: CodexTranscriptCheckpoint;
  protected readonly asyncDeliveryProjection: CodexAsyncDeliveryProjection;
  protected readonly assistantProjection: CodexAssistantProjection;
  protected readonly reasoningProjection: CodexReasoningProjection;
  readonly settlement: CodexProjectionSettlement;
  protected readonly activeItemIds = new Set<string>();
  protected readonly completedItemIds = new Set<string>();
  protected readonly activeCompactionItemIds = new Set<string>();
  protected readonly diagnostics: CodexProjectionDiagnostics;
  protected readonly generatedMediaProjection: CodexGeneratedMediaProjection;
  protected readonly eventProjection: CodexEventProjection;
  protected readonly nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector;
  protected readonly toolProgressProjection: CodexToolProgressProjection;
  protected readonly toolTranscriptProjection: CodexToolTranscriptProjection;
  protected completedTurn: CodexTurn | undefined;
  protected readonly projectionController = new AbortController();
  /** Structured overloads may continue once the exact settled transcript is captured. */
  settledTurnFailureFinalizationAllowed = false;
  protected readonly terminalFailure = new CodexTerminalFailureProjection();
  protected synthesizedMissingToolResultError: string | null = null;
  protected aborted = false;
  protected contextTokens: number | undefined;
  protected contextTokensSource: "runtime" | "runtime-configured" | "resolved" | undefined;
  protected readonly usageProjection = new CodexUsageProjection();
  protected completedCompactionCount = 0;
  protected pendingSteeringAssistantBoundaryItemId: string | undefined;

  constructor(
    protected readonly params: EmbeddedRunAttemptParams,
    protected readonly threadId: string,
    protected readonly turnId: string,
    protected readonly options: CodexAppServerEventProjectorOptions = {},
  ) {
    this.settlement = new CodexProjectionSettlement(params, () => !this.projectionClosed);
    this.transcriptCheckpoint = new CodexTranscriptCheckpoint(params, threadId, turnId);
    this.asyncDeliveryProjection = new CodexAsyncDeliveryProjection(
      params,
      threadId,
      turnId,
      options,
    );
    this.contextTokens = options.initialContextTokens;
    this.contextTokensSource = options.initialContextTokens === undefined ? undefined : "resolved";
    this.diagnostics = new CodexProjectionDiagnostics(threadId, turnId);
    this.nativeToolLifecycleProjector = new CodexNativeToolLifecycleProjector(
      params,
      threadId,
      turnId,
      {
        runAbortSignal: options.runAbortSignal,
      },
    );
    this.generatedMediaProjection = new CodexGeneratedMediaProjection(params.config, {
      remoteWorkspaceRoot: options.remoteWorkspaceRoot,
      readFile: options.readRemoteWorkspaceFile,
      requestTimeoutMs: options.remoteWorkspaceRequestTimeoutMs,
      signal: options.runAbortSignal
        ? AbortSignal.any([options.runAbortSignal, this.projectionController.signal])
        : this.projectionController.signal,
    });
    this.toolProgressProjection = new CodexToolProgressProjection(params);
    this.toolTranscriptProjection = new CodexToolTranscriptProjection(
      params,
      threadId,
      turnId,
      this.toolProgressProjection,
      this.transcriptCheckpoint.nextTimestamp,
      {
        nativePostToolUseRelayEnabled: options.nativePostToolUseRelayEnabled,
        prepareNativeMcpAppResultDetails: options.prepareNativeMcpAppResultDetails,
        trajectoryRecorder: options.trajectoryRecorder,
        checkpointMessage: this.transcriptCheckpoint.enqueue,
      },
    );
    this.eventProjection = new CodexEventProjection(
      threadId,
      turnId,
      (event) => this.emitAgentEvent(event),
      this.toolProgressProjection,
      this.toolTranscriptProjection,
      options.onNativeToolResultRecorded,
    );
    this.assistantProjection = new CodexAssistantProjection(
      this.settlement.params,
      (event) => this.emitAgentEvent(event),
      (text) => this.toolProgressProjection.matchesEcho(text),
      this.transcriptCheckpoint.nextTimestamp,
      this.transcriptCheckpoint.enqueueCommentary,
    );
    this.reasoningProjection = new CodexReasoningProjection(
      this.settlement.params,
      (event) => this.emitAgentEvent(event),
      options.onNativePlanUpdate,
    );
  }

  protected get projectionClosed(): boolean {
    return this.projectionController.signal.aborted;
  }

  buildResult(
    toolTelemetry: CodexAppServerToolTelemetry,
    options?: { yieldDetected?: boolean },
  ): EmbeddedRunAttemptResult & { terminalTurnId: string } {
    this.eventProjection.flushPendingGuardianWarning();
    // Finalizing native tools may invoke callbacks; retain this result's terminal snapshot.
    const {
      params: runParams,
      turnId,
      completedTurn,
      aborted,
      contextTokens,
      contextTokensSource,
      completedCompactionCount,
      synthesizedMissingToolResultError: previousMissingToolResultError,
    } = this;
    const {
      promptError: initialPromptError,
      promptErrorSource: initialPromptErrorSource,
      providerRefusal,
    } = this.terminalFailure;
    const upstreamUserText = this.options.upstreamUserText;
    const turnTainted = this.settlement.turnTainted;
    const activeItemCount = this.activeItemIds.size;
    const completedItemCount = this.completedItemIds.size;
    const guardianReviewCount = this.eventProjection.guardianReviewCount;
    const yieldDetected = options?.yieldDetected;
    // Result construction runs after the notification queue drains. Close any
    // tool lacking a terminal item so audit consumers never retain an open action.
    this.nativeToolLifecycleProjector.finalizeActive();
    const assistantTexts = this.assistantProjection.collectAssistantTexts();
    const asyncMessages = this.assistantProjection.collectAsyncMessages();
    const commentaryMessages = this.assistantProjection.collectCommentaryMessages();
    const reasoningText = this.reasoningProjection.reasoningText();
    const planText = this.reasoningProjection.planText();
    // Timeout recovery may still adopt a completed answer. Mask context freshness
    // until then, retaining all observed response counts for billing.
    const usage = this.usageProjection.usage;
    const projectedUsage =
      aborted && usage ? { ...usage, contextUsage: { state: "unavailable" } as const } : usage;
    const hasAssistantItemText = this.assistantProjection.hasAssistantItemTextForSynthesis();
    const legacyFailClosed =
      !completedTurn || completedTurn.status !== "completed" || hasAssistantItemText;
    const hasDeliverableAssistantOnCompletedTurn =
      completedTurn?.status === "completed" &&
      assistantTexts.some((text) => text.trim().length > 0);
    const synthesizedMissingToolResultError =
      this.toolTranscriptProjection.synthesizeMissingToolResults({
        synthesize: legacyFailClosed,
        // Preserve audit synthesis on every path, but completed answers must not
        // promote bookkeeping gaps into user-visible terminal failure evidence.
        terminalDisposition: aborted
          ? "tool_error"
          : hasDeliverableAssistantOnCompletedTurn
            ? "diagnostic_only"
            : "prompt_error",
      });
    const storedMissingToolResultError =
      synthesizedMissingToolResultError ?? previousMissingToolResultError;
    let promptErrorSource = initialPromptErrorSource;
    if (synthesizedMissingToolResultError) {
      this.synthesizedMissingToolResultError = synthesizedMissingToolResultError;
      promptErrorSource = promptErrorSource ?? "prompt";
    }
    const assistantMessageOptions = {
      tokenUsage: projectedUsage,
      aborted,
      promptError: initialPromptError,
      providerRefusal,
    };
    const lastAssistant = providerRefusal
      ? this.assistantProjection.createAssistantMessage("", assistantMessageOptions)
      : assistantTexts.length
        ? this.assistantProjection.createAssistantMessage(
            assistantTexts.join("\n\n"),
            assistantMessageOptions,
          )
        : undefined;
    const currentAttemptAssistant = providerRefusal
      ? lastAssistant
      : this.assistantProjection.createCurrentAttemptAssistantMessage(assistantMessageOptions);
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
      runParams,
      turnId,
      upstreamUserText,
      reasoningText,
      asyncMessages,
      commentaryMessages,
      toolMessages: this.toolTranscriptProjection.transcriptMessages,
      lastAssistant,
      turnTainted,
    });
    const turnFailed = completedTurn?.status === "failed";
    const promptError = providerRefusal
      ? null
      : (initialPromptError ??
        storedMissingToolResultError ??
        (turnFailed ? (completedTurn?.error?.message ?? "codex app-server turn failed") : null));
    const agentHarnessResultClassification = providerRefusal
      ? undefined
      : classifyAgentHarnessTerminalOutcome({
          assistantTexts,
          reasoningText,
          planText,
          promptError,
          turnCompleted: Boolean(completedTurn),
        });
    const toolMetas = this.toolProgressProjection.toolMetas;
    const hadPotentialSideEffects =
      toolTelemetry.didSendViaMessagingTool ||
      Boolean(toolTelemetry.successfulCronAdds || toolTelemetry.acceptedSessionSpawns?.length) ||
      this.generatedMediaProjection.hasGeneratedMedia() ||
      this.toolProgressProjection.hasPotentialSideEffects;
    const sentMediaUrls = new Set(
      toolTelemetry.messagingToolSentMediaUrls.map((url) => url.trim()),
    );
    const toolAutoDeliveryMediaUrls = toolTelemetry.toolAutoDeliveryMediaUrls?.filter(
      (url) => !sentMediaUrls.has(url.trim()),
    );
    const result = {
      terminal: attemptTerminal.normalize({
        aborted,
        promptError,
        promptErrorSource: promptError ? promptErrorSource || "prompt" : null,
      }),
      sessionIdUsed: runParams.sessionId,
      terminalTurnId: turnId,
      ...(agentHarnessResultClassification ? { agentHarnessResultClassification } : {}),
      bootstrapPromptWarningSignaturesSeen: runParams.bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature: runParams.bootstrapPromptWarningSignature,
      ...(this.usageProjection.modelIterations > 0
        ? { modelIterations: this.usageProjection.modelIterations }
        : {}),
      messagesSnapshot,
      assistantTexts,
      toolMetas,
      lastAssistant,
      currentAttemptAssistant,
      ...(this.toolProgressProjection.lastToolError
        ? { lastToolError: this.toolProgressProjection.lastToolError }
        : {}),
      didSendViaMessagingTool: toolTelemetry.didSendViaMessagingTool,
      didDeliverSourceReplyViaMessageTool:
        toolTelemetry.didDeliverSourceReplyViaMessageTool === true,
      sourceReplyDelivered: toolTelemetry.sourceReplyDelivered,
      messagingToolSentTexts: toolTelemetry.messagingToolSentTexts,
      messagingToolSentMediaUrls: toolTelemetry.messagingToolSentMediaUrls,
      messagingToolSentTargets: toolTelemetry.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: toolTelemetry.messagingToolSourceReplyPayloads ?? [],
      heartbeatToolResponse: toolTelemetry.heartbeatToolResponse,
      toolMediaUrls: this.generatedMediaProjection.buildToolMediaUrls(toolTelemetry),
      hostOwnedToolMediaUrls: this.generatedMediaProjection.buildHostOwnedMediaUrls(toolTelemetry),
      toolAudioAsVoice: toolTelemetry.toolAudioAsVoice,
      successfulCronAdds: toolTelemetry.successfulCronAdds,
      acceptedSessionSpawns: toolTelemetry.acceptedSessionSpawns,
      cloudCodeAssistFormatError: false,
      contextTokens,
      contextTokensSource,
      attemptUsage: projectedUsage,
      ...(completedCompactionCount > 0 ? { compactionCount: completedCompactionCount } : {}),
      replayMetadata: {
        hadPotentialSideEffects,
        replaySafe: !hadPotentialSideEffects,
      },
      itemLifecycle: {
        startedCount: activeItemCount + completedItemCount,
        completedCount: completedItemCount,
        activeCount: activeItemCount,
      },
      yieldDetected: yieldDetected || false,
      didSendDeterministicApprovalPrompt: guardianReviewCount > 0 ? false : undefined,
    };
    const transferTtsProvenance = resolveCodexTtsProvenanceTransfer(runParams.hostCapabilities);
    for (const toolResult of toolTelemetry.coreTtsToolResults ?? []) {
      transferTtsProvenance?.(toolResult, result, toolAutoDeliveryMediaUrls ?? []);
    }
    return result;
  }

  protected emitAgentEvent(
    event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
  ): void {
    if (!this.projectionClosed) {
      emitCodexAgentEvent(this.params, event);
    }
  }
}
