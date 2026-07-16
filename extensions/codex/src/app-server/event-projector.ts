// Codex plugin module implements event projector behavior.
import {
  classifyAgentHarnessTerminalOutcome,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexAssistantProjection } from "./event-projector-assistant.js";
import { CodexEventProjection } from "./event-projector-events.js";
import {
  itemName,
  itemStatus,
  shouldClearTerminalPresentationForNativeItem,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import { CodexGeneratedMediaProjection } from "./event-projector-media.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { CodexReasoningProjection } from "./event-projector-reasoning.js";
import { CodexToolProgressProjection } from "./event-projector-tool-progress.js";
import { CodexToolTranscriptProjection } from "./event-projector-tool-transcript.js";
import { normalizeCodexTokenUsage } from "./event-projector-usage.js";
import {
  readCodexErrorNotificationMessage,
  readItem,
  readItemString,
  readString,
} from "./event-projector-values.js";
import type { CodexNativePreToolUseFailure } from "./native-hook-relay.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import { readCodexTurn } from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexDynamicToolCallOutputContentItem,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexTurn,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";
import { createCodexUsageLimitPromptError } from "./usage-limit-error.js";
import { promptSnapshot } from "./user-prompt-message.js";

export { CodexNativeToolLifecycleProjector };
export { shouldEmitTranscriptToolProgress } from "./event-projector-tool-progress.js";

type CodexAppServerToolTelemetry = {
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
};

type CodexAppServerEventProjectorOptions = {
  nativePostToolUseRelayEnabled?: boolean;
  onNativeToolResultRecorded?: () => void | Promise<void>;
  readRecentRateLimits?: () => JsonValue | undefined;
  runAbortSignal?: AbortSignal;
  trajectoryRecorder?: CodexTrajectoryRecorder | null;
  onContextCompacted?: () => void;
  upstreamUserText?: string;
};

export class CodexAppServerEventProjector {
  private readonly assistantProjection: CodexAssistantProjection;
  private readonly reasoningProjection: CodexReasoningProjection;
  private readonly activeItemIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private readonly activeCompactionItemIds = new Set<string>();
  private readonly terminalPresentationClearedItemIds = new Set<string>();
  private readonly nativeToolOutcomeOrdinals = new Map<string, number>();
  private readonly generatedMediaProjection: CodexGeneratedMediaProjection;
  private readonly eventProjection: CodexEventProjection;
  private readonly nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector;
  private readonly toolProgressProjection: CodexToolProgressProjection;
  private readonly toolTranscriptProjection: CodexToolTranscriptProjection;
  private completedTurn: CodexTurn | undefined;
  private promptError: unknown;
  private promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
  private synthesizedMissingToolResultError: string | null = null;
  private aborted = false;
  private tokenUsage: ReturnType<typeof normalizeCodexTokenUsage>;
  private completedCompactionCount = 0;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexAppServerEventProjectorOptions = {},
  ) {
    this.nativeToolLifecycleProjector = new CodexNativeToolLifecycleProjector(
      params,
      threadId,
      turnId,
      {
        runAbortSignal: options.runAbortSignal,
      },
    );
    this.generatedMediaProjection = new CodexGeneratedMediaProjection(params.config);
    this.toolProgressProjection = new CodexToolProgressProjection(params);
    this.toolTranscriptProjection = new CodexToolTranscriptProjection(
      params,
      threadId,
      turnId,
      this.toolProgressProjection,
      {
        nativePostToolUseRelayEnabled: options.nativePostToolUseRelayEnabled,
        trajectoryRecorder: options.trajectoryRecorder,
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
      params,
      (event) => this.emitAgentEvent(event),
      (text) => this.toolProgressProjection.matchesEcho(text),
    );
    this.reasoningProjection = new CodexReasoningProjection(params, (event) =>
      this.emitAgentEvent(event),
    );
  }

  getCompletedTurnStatus(): CodexTurn["status"] | undefined {
    return this.completedTurn?.status;
  }

  hasCompletedTerminalAssistantText(): boolean {
    return this.assistantProjection.hasCompletedTerminalAssistantText(this.completedItemIds);
  }

  getLatestTerminalAssistantCandidate(): { itemId: string; hasText: boolean } | undefined {
    return this.assistantProjection.getLatestTerminalAssistantCandidate();
  }

  hasLatestTerminalAssistantCandidateText(): boolean {
    return this.assistantProjection.hasLatestTerminalAssistantCandidateText();
  }

  canReleaseLatestTerminalAssistantAfterToolHandoff(): boolean {
    return this.assistantProjection.canReleaseLatestTerminalAssistantAfterToolHandoff();
  }

  /** Restores a completed final item after only the enclosing turn timeout fired. */
  recoverCompletedTerminalAssistantAfterTurnWatchTimeout(): boolean {
    if (
      !this.aborted ||
      this.promptError !== "codex app-server attempt timed out" ||
      !this.hasCompletedTerminalAssistantText()
    ) {
      return false;
    }
    this.aborted = false;
    this.promptError = undefined;
    this.promptErrorSource = null;
    return true;
  }

  /** Resolves the shared model-order position for a native tool item. */
  recordNativeToolOutcome(item: CodexThreadItem | undefined): void {
    if (
      !item ||
      this.nativeToolOutcomeOrdinals.has(item.id) ||
      !shouldClearTerminalPresentationForNativeItem(item)
    ) {
      return;
    }
    const ordinal = this.params.allocateToolOutcomeOrdinal?.(item.id);
    if (ordinal !== undefined) {
      this.nativeToolOutcomeOrdinals.set(item.id, ordinal);
    }
  }

  recordNativeToolApprovalFailure(
    toolCallId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
  ): void {
    this.nativeToolLifecycleProjector.recordApprovalFailureDisposition(toolCallId, disposition);
  }

  recordNativeToolPreToolUseFailure(failure: CodexNativePreToolUseFailure): void {
    this.nativeToolLifecycleProjector.recordPreToolUseFailure(failure);
  }

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (isHookNotificationMethod(notification.method)) {
      if (!this.isHookNotificationForCurrentThread(params)) {
        return;
      }
    } else if (notification.method === "guardianWarning") {
      // Codex guardian warnings are thread-scoped and carry no turn id.
      if (readCodexNotificationThreadId(params) !== this.threadId) {
        return;
      }
    } else if (!this.isNotificationForTurn(params)) {
      return;
    }
    this.nativeToolLifecycleProjector.handleNotification(notification);

    switch (notification.method) {
      case "item/agentMessage/delta":
        await this.assistantProjection.handleAssistantDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.reasoningProjection.handleReasoningDelta(notification.method, params);
        break;
      case "item/plan/delta":
        this.reasoningProjection.handlePlanDelta(params);
        break;
      case "turn/plan/updated":
        this.reasoningProjection.handleTurnPlanUpdated(params);
        break;
      case "item/started":
        await this.handleItemStarted(params);
        break;
      case "item/completed":
        await this.handleItemCompleted(params);
        break;
      case "item/commandExecution/outputDelta":
        this.toolProgressProjection.handleOutputDelta(params, "bash");
        break;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        this.eventProjection.handleGuardianReview(notification.method, params);
        break;
      case "guardianWarning":
        this.eventProjection.handleGuardianWarning(params);
        break;
      case "hook/started":
      case "hook/completed":
        this.eventProjection.handleHook(notification.method, params);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(params);
        break;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        break;
      case "rawResponseItem/completed":
        await this.handleRawResponseItemCompleted(params);
        break;
      case "error":
        if (params.willRetry === true) {
          break;
        }
        this.promptError = this.formatCodexErrorMessage(params) ?? "codex app-server error";
        this.promptErrorSource = "prompt";
        break;
      default:
        break;
    }
  }

  buildResult(
    toolTelemetry: CodexAppServerToolTelemetry,
    options?: { yieldDetected?: boolean },
  ): EmbeddedRunAttemptResult {
    // Result construction runs after the notification queue drains. Close any
    // tool lacking a terminal item so audit consumers never retain an open action.
    this.nativeToolLifecycleProjector.finalizeActive();
    const assistantTexts = this.assistantProjection.collectAssistantTexts();
    const reasoningText = this.reasoningProjection.reasoningText();
    const planText = this.reasoningProjection.planText();
    const hasAssistantItemText = this.assistantProjection.hasAssistantItemTextForSynthesis();
    const legacyFailClosed =
      !this.completedTurn || this.completedTurn.status !== "completed" || hasAssistantItemText;
    const hasDeliverableAssistantOnCompletedTurn =
      this.completedTurn?.status === "completed" &&
      assistantTexts.some((text) => text.trim().length > 0);
    const synthesizedMissingToolResultError =
      this.toolTranscriptProjection.synthesizeMissingToolResults({
        synthesize: legacyFailClosed,
        recordPromptError:
          legacyFailClosed && !hasDeliverableAssistantOnCompletedTurn && !this.aborted,
      });
    if (synthesizedMissingToolResultError) {
      this.synthesizedMissingToolResultError = synthesizedMissingToolResultError;
      this.promptErrorSource = this.promptErrorSource ?? "prompt";
    }
    const assistantMessageOptions = {
      tokenUsage: this.tokenUsage,
      aborted: this.aborted,
      promptError: this.promptError,
    };
    const lastAssistant = assistantTexts.length
      ? this.assistantProjection.createAssistantMessage(
          assistantTexts.join("\n\n"),
          assistantMessageOptions,
        )
      : undefined;
    const currentAttemptAssistant =
      this.assistantProjection.createCurrentAttemptAssistantMessage(assistantMessageOptions);
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
    const turnId = this.turnId;
    const messagesSnapshot = promptSnapshot(this.params, turnId, this.options.upstreamUserText);
    // Codex owns the canonical thread. These mirror records keep enough local
    // context for OpenClaw history, search, and future harness switching.
    if (reasoningText) {
      messagesSnapshot.push(
        attachCodexMirrorIdentity(
          this.assistantProjection.createAssistantMirrorMessage("Codex reasoning", reasoningText),
          `${turnId}:reasoning`,
        ),
      );
    }
    if (planText) {
      messagesSnapshot.push(
        attachCodexMirrorIdentity(
          this.assistantProjection.createAssistantMirrorMessage("Codex plan", planText),
          `${turnId}:plan`,
        ),
      );
    }
    messagesSnapshot.push(...this.toolTranscriptProjection.transcriptMessages);
    if (lastAssistant) {
      messagesSnapshot.push(attachCodexMirrorIdentity(lastAssistant, `${turnId}:assistant`));
    }
    const turnFailed = this.completedTurn?.status === "failed";
    const promptError =
      this.promptError ??
      this.synthesizedMissingToolResultError ??
      (turnFailed ? (this.completedTurn?.error?.message ?? "codex app-server turn failed") : null);
    const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
      assistantTexts,
      reasoningText,
      planText,
      promptError,
      turnCompleted: Boolean(this.completedTurn),
    });
    const toolMetas = this.toolProgressProjection.toolMetas;
    const hadPotentialSideEffects =
      toolTelemetry.didSendViaMessagingTool ||
      (toolTelemetry.successfulCronAdds ?? 0) > 0 ||
      this.generatedMediaProjection.hasGeneratedMedia() ||
      this.toolProgressProjection.hasPotentialSideEffects;
    return {
      aborted: this.aborted,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      promptError,
      promptErrorSource: promptError ? this.promptErrorSource || "prompt" : null,
      sessionIdUsed: this.params.sessionId,
      ...(agentHarnessResultClassification ? { agentHarnessResultClassification } : {}),
      bootstrapPromptWarningSignaturesSeen: this.params.bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature: this.params.bootstrapPromptWarningSignature,
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
      messagingToolSentTexts: toolTelemetry.messagingToolSentTexts,
      messagingToolSentMediaUrls: toolTelemetry.messagingToolSentMediaUrls,
      messagingToolSentTargets: toolTelemetry.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: toolTelemetry.messagingToolSourceReplyPayloads ?? [],
      heartbeatToolResponse: toolTelemetry.heartbeatToolResponse,
      toolMediaUrls: this.generatedMediaProjection.buildToolMediaUrls(toolTelemetry),
      toolAudioAsVoice: toolTelemetry.toolAudioAsVoice,
      successfulCronAdds: toolTelemetry.successfulCronAdds,
      cloudCodeAssistFormatError: false,
      attemptUsage: this.tokenUsage,
      replayMetadata: {
        hadPotentialSideEffects,
        replaySafe: !hadPotentialSideEffects,
      },
      itemLifecycle: {
        startedCount: this.activeItemIds.size + this.completedItemIds.size,
        completedCount: this.completedItemIds.size,
        activeCount: this.activeItemIds.size,
        ...(this.completedCompactionCount > 0
          ? { compactionCount: this.completedCompactionCount }
          : {}),
      },
      yieldDetected: options?.yieldDetected || false,
      didSendDeterministicApprovalPrompt:
        this.eventProjection.guardianReviewCount > 0 ? false : undefined,
    };
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    this.toolTranscriptProjection.recordDynamicToolCall(params);
  }

  recordDynamicToolResult(params: {
    callId: string;
    tool: string;
    asyncStarted?: boolean;
    success: boolean;
    terminalType?: "blocked" | "completed" | "error";
    sideEffectEvidence?: boolean;
    contentItems: CodexDynamicToolCallOutputContentItem[];
  }): void {
    this.toolProgressProjection.recordDynamicToolResult(params);
    this.toolTranscriptProjection.recordDynamicToolResult(params);
  }

  markTimedOut(): void {
    this.aborted = true;
    this.promptError = "codex app-server attempt timed out";
    this.promptErrorSource = "prompt";
  }

  markAborted(): void {
    this.aborted = true;
  }

  isCompacting(): boolean {
    return this.activeCompactionItemIds.size > 0;
  }

  private async handleItemStarted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    const itemId = item?.id ?? readString(params, "itemId");
    this.assistantProjection.recordItemStarted(item, itemId);
    if (itemId) {
      this.activeItemIds.add(itemId);
    }
    this.recordNativeToolOutcome(item);
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.add(itemId);
      await runAgentHarnessBeforeCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: await this.toolTranscriptProjection.readMirroredSessionMessages(),
        ctx: {
          runId: this.params.runId,
          agentId: this.params.agentId,
          sessionKey: this.params.sessionKey,
          sessionId: this.params.sessionId,
          workspaceDir: this.params.workspaceDir,
          messageProvider: this.params.messageProvider ?? undefined,
          trigger: this.params.trigger,
          channelId: this.params.messageChannel ?? this.params.messageProvider ?? undefined,
        },
      });
      this.emitAgentEvent({
        stream: "compaction",
        data: {
          phase: "start",
          backend: "codex-app-server",
          threadId: this.threadId,
          turnId: this.turnId,
          itemId,
        },
      });
    }
    this.toolProgressProjection.recordToolMeta(item);
    this.eventProjection.emitStandardItemEvent({ phase: "start", item });
    await this.eventProjection.emitNormalizedToolItemEvent({ phase: "start", item });
    this.toolTranscriptProjection.recordNativeToolCall(item);
    this.toolProgressProjection.emitToolResultSummary(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "started", itemId, type: item?.type },
    });
  }

  private async handleItemCompleted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    this.recordNativeToolOutcome(item);
    this.clearTerminalPresentationForNativeItem(item);
    const itemId = item?.id ?? readString(params, "itemId");
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
    }
    this.assistantProjection.recordItemCompleted(item, itemId, this.activeItemIds);
    this.reasoningProjection.recordItem(item);
    this.generatedMediaProjection.recordNative(item);
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.delete(itemId);
      this.completedCompactionCount += 1;
      this.options.onContextCompacted?.();
      await runAgentHarnessAfterCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: await this.toolTranscriptProjection.readMirroredSessionMessages(),
        compactedCount: -1,
        ctx: {
          runId: this.params.runId,
          agentId: this.params.agentId,
          sessionKey: this.params.sessionKey,
          sessionId: this.params.sessionId,
          workspaceDir: this.params.workspaceDir,
          messageProvider: this.params.messageProvider ?? undefined,
          trigger: this.params.trigger,
          channelId: this.params.messageChannel ?? this.params.messageProvider ?? undefined,
        },
      });
      this.emitAgentEvent({
        stream: "compaction",
        data: {
          phase: "end",
          backend: "codex-app-server",
          completed: true,
          threadId: this.threadId,
          turnId: this.turnId,
          itemId,
        },
      });
    }
    this.toolProgressProjection.recordToolMeta(item);
    this.toolProgressProjection.rememberCommandAggregateOutputEcho(item);
    this.eventProjection.emitStandardItemEvent({ phase: "end", item });
    await this.eventProjection.emitNormalizedToolItemEvent({ phase: "result", item });
    this.toolTranscriptProjection.recordNativeToolCall(item);
    this.toolTranscriptProjection.recordNativeToolResult(item);
    this.toolProgressProjection.emitToolResultSummary(item);
    this.toolProgressProjection.emitToolResultOutput(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "completed", itemId, type: item?.type },
    });
  }

  private handleTokenUsage(params: JsonObject): void {
    // v2 ThreadTokenUsageUpdatedNotification: tokenUsage = {total, last, modelContextWindow}.
    const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
    const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
    if (!last) {
      return;
    }
    const usage = normalizeCodexTokenUsage(last);
    if (usage) {
      this.tokenUsage = usage;
    }
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const turn = readCodexTurn(params.turn);
    if (!turn || turn.id !== this.turnId) {
      return;
    }
    this.completedTurn = turn;
    if (turn.status === "failed") {
      const usageLimitMessage = formatCodexUsageLimitErrorMessage({
        message: turn.error?.message,
        codexErrorInfo: turn.error?.codexErrorInfo as JsonValue | null | undefined,
        rateLimits: this.options.readRecentRateLimits?.(),
      });
      this.promptError = usageLimitMessage
        ? createCodexUsageLimitPromptError(usageLimitMessage)
        : (turn.error?.message ?? "codex app-server turn failed");
      this.promptErrorSource = "prompt";
    }
    const turnItems = turn.items ?? [];
    // The final snapshot is authoritative when item notifications were omitted.
    // Only its last relevant tool may change the terminal presentation.
    for (let index = turnItems.length - 1; index >= 0; index -= 1) {
      const item = turnItems[index];
      if (!item || !this.isCurrentTurnSnapshotItem(item)) {
        continue;
      }
      if (item?.type === "dynamicToolCall") {
        break;
      }
      if (shouldClearTerminalPresentationForNativeItem(item)) {
        this.clearTerminalPresentationForNativeItem(item);
        break;
      }
    }
    for (const item of turnItems) {
      this.assistantProjection.recordSnapshotItem(item);
      this.reasoningProjection.recordItem(item);
      this.generatedMediaProjection.recordNative(item);
      this.toolProgressProjection.recordToolMeta(item);
      this.toolProgressProjection.rememberCommandAggregateOutputEcho(item);
      await this.emitSnapshotOnlyNativeToolProgress(item);
      this.toolTranscriptProjection.recordNativeToolCall(item);
      this.toolTranscriptProjection.recordNativeToolResult(item);
      this.toolTranscriptProjection.emitAfterToolCallObservation(item);
      this.toolProgressProjection.emitToolResultSummary(item);
      this.toolProgressProjection.emitToolResultOutput(item);
    }
    this.activeCompactionItemIds.clear();
    await this.reasoningProjection.maybeEndReasoning();
  }

  private async emitSnapshotOnlyNativeToolProgress(item: CodexThreadItem): Promise<void> {
    if (
      !shouldSynthesizeToolProgressForItem(item) ||
      !this.isCurrentTurnSnapshotItem(item) ||
      this.completedItemIds.has(item.id) ||
      itemStatus(item) === "running"
    ) {
      return;
    }
    const wasStarted = this.activeItemIds.has(item.id);
    if (!wasStarted) {
      this.eventProjection.emitStandardItemEvent({ phase: "start", item });
      await this.eventProjection.emitNormalizedToolItemEvent({ phase: "start", item });
    }
    this.activeItemIds.delete(item.id);
    this.eventProjection.emitStandardItemEvent({ phase: "end", item });
    await this.eventProjection.emitNormalizedToolItemEvent({ phase: "result", item });
    this.completedItemIds.add(item.id);
  }

  private isCurrentTurnSnapshotItem(item: CodexThreadItem): boolean {
    const itemTurnId = readItemString(item, "turnId");
    return itemTurnId === undefined || itemTurnId === this.turnId;
  }

  private async handleRawResponseItemCompleted(params: JsonObject): Promise<void> {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item) {
      return;
    }
    // Project protocol state before media persistence yields. Notifications may overlap,
    // so delayed image I/O must not consume assistant-echo state from a newer item.
    this.assistantProjection.handleRawResponseItemCompleted(item, this.activeItemIds);
    await this.generatedMediaProjection.recordRaw(item);
  }

  private clearTerminalPresentationForNativeItem(item: CodexThreadItem | undefined): void {
    if (
      !item ||
      this.terminalPresentationClearedItemIds.has(item.id) ||
      !shouldClearTerminalPresentationForNativeItem(item)
    ) {
      return;
    }
    const toolCallOrdinal = this.nativeToolOutcomeOrdinals.get(item.id);
    this.terminalPresentationClearedItemIds.add(item.id);
    this.params.onToolOutcome?.({
      toolName: itemName(item) ?? item.type,
      argsHash: "",
      resultHash: "",
      ...(toolCallOrdinal !== undefined ? { toolCallOrdinal } : {}),
      terminalPresentation: undefined,
      presentationOnly: true,
    });
  }

  private formatCodexErrorMessage(params: JsonObject): string | Error | undefined {
    const error = isJsonObject(params.error) ? params.error : undefined;
    const usageLimitMessage = formatCodexUsageLimitErrorMessage({
      message: error ? readString(error, "message") : undefined,
      codexErrorInfo: error?.codexErrorInfo,
      rateLimits: this.options.readRecentRateLimits?.(),
    });
    return usageLimitMessage
      ? createCodexUsageLimitPromptError(usageLimitMessage)
      : readCodexErrorNotificationMessage(params);
  }

  private emitAgentEvent(
    event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
  ): void {
    try {
      emitGlobalAgentEvent({
        runId: this.params.runId,
        stream: event.stream,
        data: event.data,
        ...(this.params.sessionKey ? { sessionKey: this.params.sessionKey } : {}),
      });
    } catch (error) {
      embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
    }
    try {
      const maybePromise = this.params.onAgentEvent?.(event);
      void Promise.resolve(maybePromise).catch((error: unknown) => {
        embeddedAgentLog.debug("codex app-server agent event handler rejected", { error });
      });
    } catch (error) {
      // Downstream event consumers must not corrupt the canonical Codex turn projection.
      embeddedAgentLog.debug("codex app-server agent event handler threw", { error });
    }
  }

  private isNotificationForTurn(params: JsonObject): boolean {
    const threadId = readCodexNotificationThreadId(params);
    const turnId = readCodexNotificationTurnId(params);
    return threadId === this.threadId && turnId === this.turnId;
  }

  private isHookNotificationForCurrentThread(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turnId = params.turnId;
    return threadId === this.threadId && (turnId === this.turnId || turnId === null);
  }
}

function isHookNotificationMethod(method: string): method is "hook/started" | "hook/completed" {
  return method === "hook/started" || method === "hook/completed";
}
