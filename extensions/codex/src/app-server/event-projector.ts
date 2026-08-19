// Codex plugin module implements event projector behavior.
import {
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AttemptFailureSource, EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { CodexAssistantProjection } from "./event-projector-assistant.js";
import { CodexProjectionDiagnostics } from "./event-projector-diagnostics.js";
import { CodexEventProjection } from "./event-projector-events.js";
import {
  itemName,
  itemStatus,
  shouldClearTerminalPresentationForNativeItem,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import { CodexGeneratedMediaProjection } from "./event-projector-media.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import type { CodexAppServerEventProjectorOptions } from "./event-projector-options.js";
import { CodexReasoningProjection } from "./event-projector-reasoning.js";
import {
  buildCodexAttemptResult,
  type CodexAppServerToolTelemetry,
} from "./event-projector-result.js";
import { CodexToolProgressProjection } from "./event-projector-tool-progress.js";
import { CodexToolTranscriptProjection } from "./event-projector-tool-transcript.js";
import {
  CodexResponseCompletionProjection,
  normalizeCodexThreadTokenUsage,
  projectCodexThreadUsageUpdate,
} from "./event-projector-usage.js";
import {
  readCodexErrorNotificationMessage,
  readItem,
  readItemString,
} from "./event-projector-values.js";
import type { CodexNativePreToolUseFailure } from "./native-hook-relay.js";
import {
  isCodexNotificationForTurn,
  readCodexNotificationThreadId,
} from "./notification-correlation.js";
import type { CodexApprovalKind } from "./plugin-approval-roundtrip.js";
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
import { createCodexUsageLimitPromptError } from "./usage-limit-error.js";

export { shouldEmitTranscriptToolProgress } from "./event-projector-tool-progress.js";

type ApprovalFailure = Exclude<BeforeToolCallFailureDisposition, "blocked">;

export class CodexAppServerEventProjector {
  private readonly assistantProjection: CodexAssistantProjection;
  private readonly reasoningProjection: CodexReasoningProjection;
  private readonly activeItemIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private readonly activeCompactionItemIds = new Set<string>();
  private readonly terminalPresentationClearedItemIds = new Set<string>();
  private readonly nativeToolOutcomeOrdinals = new Map<string, number>();
  private readonly diagnostics: CodexProjectionDiagnostics;
  private readonly generatedMediaProjection: CodexGeneratedMediaProjection;
  private readonly eventProjection: CodexEventProjection;
  private readonly nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector;
  private readonly toolProgressProjection: CodexToolProgressProjection;
  private readonly toolTranscriptProjection: CodexToolTranscriptProjection;
  private completedTurn: CodexTurn | undefined;
  /** Structured overloads may continue once the exact settled transcript is captured. */
  settledTurnFailureFinalizationAllowed = false;
  private promptError: unknown;
  private promptErrorSource: AttemptFailureSource | null = null;
  private synthesizedMissingToolResultError: string | null = null;
  private aborted = false;
  private tokenUsage: ReturnType<typeof normalizeCodexThreadTokenUsage>;
  private contextTokens: number | undefined;
  private contextTokensSource: "runtime" | "runtime-configured" | "resolved" | undefined;
  private readonly responseCompletions = new CodexResponseCompletionProjection();
  private completedCompactionCount = 0;
  private lastTranscriptTimestamp = 0;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexAppServerEventProjectorOptions = {},
  ) {
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
      signal: options.runAbortSignal,
    });
    this.toolProgressProjection = new CodexToolProgressProjection(params);
    this.toolTranscriptProjection = new CodexToolTranscriptProjection(
      params,
      threadId,
      turnId,
      this.toolProgressProjection,
      () => this.nextTranscriptTimestamp(),
      {
        nativePostToolUseRelayEnabled: options.nativePostToolUseRelayEnabled,
        prepareNativeMcpAppResultDetails: options.prepareNativeMcpAppResultDetails,
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
      () => this.nextTranscriptTimestamp(),
    );
    this.reasoningProjection = new CodexReasoningProjection(
      params,
      (event) => this.emitAgentEvent(event),
      options.onNativePlanUpdate,
    );
  }

  private nextTranscriptTimestamp(): number {
    // Commentary and tool mirrors share this clock so equal wall-clock values
    // still preserve the app-server receipt order in the durable transcript.
    this.lastTranscriptTimestamp = Math.max(Date.now(), this.lastTranscriptTimestamp + 1);
    return this.lastTranscriptTimestamp;
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
    disposition: ApprovalFailure,
    approvalKind?: CodexApprovalKind,
  ): void {
    this.nativeToolLifecycleProjector.recordApprovalFailureDisposition(toolCallId, disposition);
    if (disposition === "timed_out" && approvalKind) {
      this.toolProgressProjection.approvalTimeoutKinds.set(toolCallId, approvalKind);
    }
  }

  recordNativeToolPreToolUseFailure(failure: CodexNativePreToolUseFailure): void {
    this.nativeToolLifecycleProjector.recordPreToolUseFailure(failure);
  }

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (notification.method === "hook/started" || notification.method === "hook/completed") {
      if (!this.isHookNotificationForCurrentThread(params)) {
        return;
      }
    } else if (notification.method === "guardianWarning") {
      // Codex guardian warnings are thread-scoped and carry no turn id.
      if (readCodexNotificationThreadId(params) !== this.threadId) {
        return;
      }
    } else if (!isCodexNotificationForTurn(params, this.threadId, this.turnId)) {
      return;
    }
    if (
      notification.method !== "guardianWarning" &&
      notification.method !== "item/autoApprovalReview/started" &&
      notification.method !== "item/autoApprovalReview/completed"
    ) {
      this.eventProjection.flushPendingGuardianWarning();
    }
    this.nativeToolLifecycleProjector.handleNotification(notification);
    this.assistantProjection.handleNotification(notification.method, params);

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
        await this.reasoningProjection.handleTurnPlanUpdated(params);
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
        projectCodexThreadUsageUpdate(
          params,
          this.tokenUsage,
          (usage) => (this.tokenUsage = usage),
          (data) => {
            if (data.modelContextWindow !== undefined) {
              this.contextTokens = data.modelContextWindow;
              // Codex reports the effective thread window. When OpenClaw supplied an
              // authored cap, retain that fact so removing the cap cannot make the
              // constrained observation look like uncapped native telemetry.
              this.contextTokensSource =
                this.params.authoredContextTokenCap === undefined
                  ? "runtime"
                  : "runtime-configured";
            }
            this.emitAgentEvent({ stream: "codex_app_server.usage", data });
          },
        );
        break;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        break;
      case "rawResponse/completed":
        this.responseCompletions.record(params);
        break;
      case "rawResponseItem/completed":
        await this.handleRawResponseItemCompleted(params);
        break;
      case "error": {
        this.responseCompletions.clear();
        if (params.willRetry === true) {
          break;
        }
        const codexErrorInfo = isJsonObject(params.error) ? params.error.codexErrorInfo : undefined;
        const compactionFailure = codexErrorInfo === "other" && this.isCompacting();
        this.settledTurnFailureFinalizationAllowed =
          codexErrorInfo === "serverOverloaded" || compactionFailure;
        this.promptError = this.formatCodexErrorMessage(params) ?? "codex app-server error";
        this.promptErrorSource = compactionFailure ? "compaction" : "prompt";
        break;
      }
      case "thread/compacted":
      case "turn/started":
      case "turn/diff/updated":
      case "item/reasoning/summaryPartAdded":
      case "item/commandExecution/terminalInteraction":
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
      case "item/mcpToolCall/progress":
      case "model/rerouted":
      case "model/verification":
      case "turn/moderationMetadata":
      case "model/safetyBuffering/updated":
        break;
      default:
        this.diagnostics.warnUnknownEvent(notification, params);
        break;
    }
  }

  buildResult(
    toolTelemetry: CodexAppServerToolTelemetry,
    options?: { yieldDetected?: boolean },
  ): EmbeddedRunAttemptResult & { terminalTurnId: string } {
    this.eventProjection.flushPendingGuardianWarning();
    return buildCodexAttemptResult({
      runParams: this.params,
      turnId: this.turnId,
      upstreamUserText: this.options.upstreamUserText,
      completedTurn: this.completedTurn,
      promptError: this.promptError,
      promptErrorSource: this.promptErrorSource,
      synthesizedMissingToolResultError: this.synthesizedMissingToolResultError,
      recordSynthesizedMissingToolResultError: (error) => {
        this.synthesizedMissingToolResultError = error;
        this.promptErrorSource = this.promptErrorSource ?? "prompt";
      },
      aborted: this.aborted,
      tokenUsage: this.tokenUsage,
      contextTokens: this.contextTokens,
      contextTokensSource: this.contextTokensSource,
      completedCompactionCount: this.completedCompactionCount,
      activeItemCount: this.activeItemIds.size,
      completedItemCount: this.completedItemIds.size,
      guardianReviewCount: this.eventProjection.guardianReviewCount,
      toolTelemetry,
      yieldDetected: options?.yieldDetected,
      nativeToolLifecycleProjection: this.nativeToolLifecycleProjector,
      assistantProjection: this.assistantProjection,
      reasoningProjection: this.reasoningProjection,
      responseCompletions: this.responseCompletions,
      toolTranscriptProjection: this.toolTranscriptProjection,
      toolProgressProjection: this.toolProgressProjection,
      generatedMediaProjection: this.generatedMediaProjection,
    });
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    this.toolTranscriptProjection.recordDynamicToolCall(params);
  }

  /** Projects a successful OpenClaw progress_card call through the native plan stream. */
  async recordDynamicProgressCardUpdate(params: unknown): Promise<void> {
    if (isJsonObject(params)) {
      const projected: JsonObject = {
        plan: Array.isArray(params.plan) ? params.plan : [],
      };
      await this.reasoningProjection.handleTurnPlanUpdated(projected, "openclaw");
    }
  }

  recordDynamicToolResult(params: {
    callId: string;
    tool: string;
    asyncStarted?: boolean;
    terminalResolution?: ReturnType<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>;
    success: boolean;
    terminalType?: "blocked" | "completed" | "error";
    sideEffectEvidence?: boolean;
    contentItems: CodexDynamicToolCallOutputContentItem[];
    details?: unknown;
  }): void {
    this.toolProgressProjection.recordDynamicToolResult(params);
    const source = this.options.resolveDynamicToolResultContentSource?.(params.tool);
    this.toolTranscriptProjection.recordDynamicToolResult(params, source);
  }

  markTimedOut(): void {
    this.aborted = true;
    this.promptError = "codex app-server attempt timed out";
    this.promptErrorSource = "prompt";
  }

  markAborted(): void {
    this.aborted = true;
    this.responseCompletions.clear();
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
    this.diagnostics.warnUnknownItemStatus(item);
    this.recordNativeToolOutcome(item);
    this.clearTerminalPresentationForNativeItem(item);
    const itemId = item?.id ?? readString(params, "itemId");
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
    }
    this.assistantProjection.recordItemCompleted(item, itemId, this.activeItemIds);
    this.reasoningProjection.recordItem(item);
    await this.generatedMediaProjection.recordNative(item);
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.delete(itemId);
      this.completedCompactionCount += 1;
      await this.options.onContextCompacted?.();
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
      this.emitCompactionEnd(itemId, true);
    }
    this.toolProgressProjection.recordToolMeta(item);
    this.toolProgressProjection.rememberCommandAggregateOutputEcho(item);
    this.eventProjection.emitStandardItemEvent({ phase: "end", item });
    await this.eventProjection.emitNormalizedToolItemEvent({ phase: "result", item });
    this.toolTranscriptProjection.recordNativeToolCall(item);
    await this.toolTranscriptProjection.recordNativeToolResultWithDetails(item);
    this.toolProgressProjection.emitToolResultSummary(item);
    this.toolProgressProjection.emitToolResultOutput(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "completed", itemId, type: item?.type },
    });
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const turn = readCodexTurn(params.turn);
    if (!turn || turn.id !== this.turnId) {
      return;
    }
    this.completedTurn = turn;
    const compactionFailure =
      turn.status === "failed" &&
      (this.promptErrorSource === "compaction" ||
        (turn.error?.codexErrorInfo === "other" && this.isCompacting()));
    this.settledTurnFailureFinalizationAllowed =
      turn.status === "failed" &&
      (turn.error?.codexErrorInfo === "serverOverloaded" || compactionFailure);
    if (turn.status !== "completed") {
      this.responseCompletions.clear();
    }
    if (turn.status === "failed") {
      const usageLimitMessage = formatCodexUsageLimitErrorMessage({
        message: turn.error?.message,
        codexErrorInfo: turn.error?.codexErrorInfo as JsonValue | null | undefined,
        rateLimits: this.options.readRecentRateLimits?.(),
      });
      this.promptError = usageLimitMessage
        ? createCodexUsageLimitPromptError(usageLimitMessage)
        : (turn.error?.message ?? "codex app-server turn failed");
      this.promptErrorSource = compactionFailure ? "compaction" : "prompt";
    }
    if (compactionFailure) {
      // Codex omits item/completed on failure, so the terminal turn must close
      // every active structural compaction for state and stream consumers.
      const failedCompactionItemIds = [...this.activeCompactionItemIds];
      for (const itemId of failedCompactionItemIds) {
        this.activeItemIds.delete(itemId);
        this.activeCompactionItemIds.delete(itemId);
        this.emitCompactionEnd(itemId, false);
      }
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
      this.diagnostics.warnUnknownItemStatus(item);
      this.assistantProjection.recordSnapshotItem(item);
      this.reasoningProjection.recordItem(item);
      await this.generatedMediaProjection.recordNative(item);
      this.toolProgressProjection.recordToolMeta(item);
      this.toolProgressProjection.rememberCommandAggregateOutputEcho(item);
      await this.emitSnapshotOnlyNativeToolProgress(item);
      this.toolTranscriptProjection.recordNativeToolCall(item);
      await this.toolTranscriptProjection.recordNativeToolResultWithDetails(item);
      this.toolTranscriptProjection.emitAfterToolCallObservation(item);
      this.toolProgressProjection.emitToolResultSummary(item);
      this.toolProgressProjection.emitToolResultOutput(item);
    }
    this.toolProgressProjection.approvalTimeoutKinds.clear();
    this.assistantProjection.finalizeAnswerCandidate(turn);
    this.activeCompactionItemIds.clear();
    await this.reasoningProjection.maybeEndReasoning();
  }

  private emitCompactionEnd(itemId: string, completed: boolean): void {
    this.emitAgentEvent({
      stream: "compaction",
      data: {
        phase: "end",
        backend: "codex-app-server",
        completed,
        threadId: this.threadId,
        turnId: this.turnId,
        itemId,
      },
    });
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
    this.toolTranscriptProjection.recordRawNativeToolItem(item);
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

  private isHookNotificationForCurrentThread(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turnId = params.turnId;
    return threadId === this.threadId && (turnId === this.turnId || turnId === null);
  }
}
