import {
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  projectProgressCardChannelUpdate,
  type AgentMessage,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";
import {
  matchesCodexSnapshotTurn,
  shouldClearTerminalPresentationForNativeItem,
} from "./event-projector-items.js";
import { CodexTurnProjection } from "./event-projector-result.js";
import { buildCodexSteeringMessagesSnapshot } from "./event-projector-snapshot.js";
import { readCodexErrorNotificationMessage, readItem } from "./event-projector-values.js";
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

export class CodexAppServerEventProjector extends CodexTurnProjection {
  getCompletedTurnStatus(): CodexTurn["status"] | undefined {
    return this.completedTurn?.status;
  }

  /** Native completion owns the answer independently of unfinished host projection. */
  recoverCompletedAnswer(): boolean {
    const completed = this.settlement.completedAnswer;
    if (!completed || this.aborted || this.terminalFailure.promptError) {
      return false;
    }
    // Retire accepted writes before the enriched final enters the same mirror owner.
    this.projectionController.abort();
    this.transcriptCheckpoint.abandon();
    this.completedTurn = completed.turn;
    this.assistantProjection.recordSnapshotItem(completed.answer);
    this.assistantProjection.finalizeAnswerCandidate(completed.turn);
    return true;
  }

  getActiveMcpToolCall(serverName: string) {
    if (this.projectionClosed || this.aborted) {
      return undefined;
    }
    return this.nativeToolLifecycleProjector.getActiveMcpToolCall(serverName);
  }

  recordMcpToolCallReceipt(notification: CodexServerNotification): void {
    if (!this.projectionClosed) {
      this.nativeToolLifecycleProjector.recordMcpToolCallReceipt(notification);
    }
  }

  buildSteeringTranscriptPrefix(): AgentMessage[] {
    const snapshot = buildCodexSteeringMessagesSnapshot({
      runParams: this.params,
      turnId: this.turnId,
      upstreamUserText: this.options.upstreamUserText,
      completedItemIds: this.completedItemIds,
      assistantProjection: this.assistantProjection,
      toolMessages: this.toolTranscriptProjection.transcriptMessages,
    });
    this.pendingSteeringAssistantBoundaryItemId = snapshot.assistantBoundaryItemId;
    return snapshot.messages;
  }

  markSteeringTranscriptPersisted(): void {
    const itemId = this.pendingSteeringAssistantBoundaryItemId;
    if (itemId) {
      this.assistantProjection.markAssistantBoundaryPersisted(itemId);
      this.pendingSteeringAssistantBoundaryItemId = undefined;
    }
  }

  /** Fence delayed projections before the turn's final snapshot leaves its owner. */
  closeProjection(): Promise<void> {
    this.projectionController.abort();
    return this.settlement.project("transcript/checkpoint", () =>
      this.transcriptCheckpoint.flush(true),
    );
  }

  /** Resolves the shared model-order position for a native tool item. */
  recordNativeToolOutcome(item: CodexThreadItem | undefined): void {
    this.nativeToolLifecycleProjector.recordNativeToolOutcome(item);
  }

  recordNativeToolApprovalFailure(
    toolCallId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
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
    if (this.projectionClosed) {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (notification.method === "hook/started" || notification.method === "hook/completed") {
      if (!this.isHookNotificationForCurrentThread(params)) {
        return;
      }
    } else if (
      notification.method === "guardianWarning" ||
      notification.method === "warning" ||
      notification.method === "configWarning"
    ) {
      // Codex warnings are process- or thread-scoped and never carry a turn id.
      const warningThreadId = readCodexNotificationThreadId(params);
      if (
        (notification.method === "guardianWarning" && warningThreadId !== this.threadId) ||
        (warningThreadId && warningThreadId !== this.threadId)
      ) {
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
      case "autoApprovalReview/strictReviewRequired":
        this.eventProjection.handleStrictReviewRequired(params);
        break;
      case "guardianWarning":
        this.eventProjection.handleGuardianWarning(params);
        break;
      case "warning":
      case "configWarning":
        this.eventProjection.handleWarning(params);
        break;
      case "hook/started":
      case "hook/completed":
        this.eventProjection.handleHook(notification.method, params);
        break;
      case "thread/tokenUsage/updated": {
        const data = this.usageProjection.recordThread(params);
        if (data.modelContextWindow !== undefined) {
          this.contextTokens = data.modelContextWindow;
          // Retain an authored cap so its removal cannot make a constrained
          // native window look like an uncapped runtime observation.
          this.contextTokensSource =
            this.params.authoredContextTokenCap === undefined ? "runtime" : "runtime-configured";
        }
        if (Object.keys(data).length > 0) {
          this.emitAgentEvent({ stream: "usage", data });
        }
        break;
      }
      case "turn/completed":
        await this.handleTurnCompleted(params);
        break;
      case "rawResponse/completed":
        this.usageProjection.record(params, this.params.hostCapabilities.reportOutputTokens);
        break;
      case "rawResponseItem/completed":
        await this.handleRawResponseItemCompleted(params);
        break;
      case "model/rerouted":
        this.eventProjection.handleModelRerouted(params);
        break;
      case "error": {
        this.usageProjection.invalidateContext();
        if (params.willRetry === true) {
          this.eventProjection.handleRetry(params);
          break;
        }
        const codexErrorInfo = isJsonObject(params.error) ? params.error.codexErrorInfo : undefined;
        const compactionFailure = codexErrorInfo === "other" && this.isCompacting();
        this.settledTurnFailureFinalizationAllowed =
          codexErrorInfo === "serverOverloaded" || compactionFailure;
        this.terminalFailure.record({
          message: readCodexErrorNotificationMessage(params),
          codexErrorInfo,
          rateLimits: this.options.readRecentRateLimits?.(),
          fallbackMessage: "codex app-server error",
          promptErrorSource: compactionFailure ? "compaction" : "prompt",
        });
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
      case "model/verification":
      case "turn/moderationMetadata":
      case "model/safetyBuffering/updated":
        break;
      default:
        this.diagnostics.warnUnknownEvent(notification, params);
        break;
    }
    if (
      !this.projectionClosed &&
      ["item/started", "item/completed", "rawResponseItem/completed"].includes(notification.method)
    ) {
      await this.settlement.project("transcript/checkpoint", () =>
        this.transcriptCheckpoint.flush(),
      );
    }
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    this.toolTranscriptProjection.recordDynamicToolCall(params);
  }

  /** Projects a successful OpenClaw progress_card call through the native plan stream. */
  async recordDynamicProgressCardUpdate(params: unknown): Promise<void> {
    const update = projectProgressCardChannelUpdate(params);
    if (update) {
      const projected: JsonObject = {
        plan: update.steps,
        ...(update.explanation ? { explanation: update.explanation } : {}),
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
    this.terminalFailure.promptError = "codex app-server attempt timed out";
    this.terminalFailure.promptErrorSource = "prompt";
  }

  markAborted(): void {
    this.aborted = true;
    this.usageProjection.invalidateContext();
  }

  isCompacting(): boolean {
    return this.activeCompactionItemIds.size > 0;
  }

  private isCompactionProjectionActive(): boolean {
    // History reads and hooks can settle after their projector closes or aborts.
    return !this.projectionClosed && !this.aborted && !this.options.runAbortSignal?.aborted;
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
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      this.activeCompactionItemIds.add(itemId);
      const messages = await this.toolTranscriptProjection.readMirroredSessionMessages(
        this.options.runAbortSignal,
      );
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      await runAgentHarnessBeforeCompactionHook({
        sessionFile: this.params.sessionFile,
        messages,
        ctx: this.options.agentHookContext ?? {},
      });
      if (!this.isCompactionProjectionActive()) {
        return;
      }
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
    if (this.projectionClosed) {
      return;
    }
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
    this.nativeToolLifecycleProjector.clearTerminalPresentationForNativeItem(item);
    const itemId = item?.id ?? readString(params, "itemId");
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
    }
    if (!this.asyncDeliveryProjection.allows(item, true)) {
      return;
    }
    const asyncMessage = this.assistantProjection.recordItemCompleted(
      item,
      itemId,
      this.activeItemIds,
    );
    if (asyncMessage) {
      await this.asyncDeliveryProjection.deliver(asyncMessage);
    }
    if (this.projectionClosed) {
      return;
    }
    this.reasoningProjection.recordItem(item);
    await this.settlement.project("media_projection", () =>
      this.generatedMediaProjection.recordNative(item),
    );
    if (this.projectionClosed) {
      return;
    }
    if (item?.type === "contextCompaction" && itemId) {
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      this.activeCompactionItemIds.delete(itemId);
      this.completedCompactionCount += 1;
      await this.options.onContextCompacted?.();
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      const messages = await this.toolTranscriptProjection.readMirroredSessionMessages(
        this.options.runAbortSignal,
      );
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      await runAgentHarnessAfterCompactionHook({
        sessionFile: this.params.sessionFile,
        messages,
        compactedCount: -1,
        ctx: this.options.agentHookContext ?? {},
      });
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      await persistCodexContextCompactionActivity({
        sessionTarget: this.params.sessionTarget,
        config: this.params.config,
        cwd: this.params.workspaceDir,
        runId: this.params.runId,
        threadId: this.threadId,
        turnId: this.turnId,
        itemId,
        timestamp: this.transcriptCheckpoint.nextTimestamp(),
      });
      if (!this.isCompactionProjectionActive()) {
        return;
      }
      this.eventProjection.emitCompactionEnd(itemId, true);
    }
    this.toolProgressProjection.recordToolMeta(item);
    this.toolProgressProjection.rememberCommandAggregateOutputEcho(item);
    this.eventProjection.emitStandardItemEvent({ phase: "end", item });
    await this.eventProjection.emitNormalizedToolItemEvent({ phase: "result", item });
    if (this.projectionClosed) {
      return;
    }
    this.toolTranscriptProjection.recordNativeToolCall(item);
    const details = await this.toolTranscriptProjection.prepareNativeToolResultDetails(item);
    if (this.projectionClosed) {
      return;
    }
    this.toolTranscriptProjection.recordNativeToolResult(item, details);
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
      (this.terminalFailure.promptErrorSource === "compaction" ||
        (turn.error?.codexErrorInfo === "other" && this.isCompacting()));
    this.settledTurnFailureFinalizationAllowed =
      turn.status === "failed" &&
      (turn.error?.codexErrorInfo === "serverOverloaded" || compactionFailure);
    if (turn.status !== "completed") {
      this.usageProjection.invalidateContext();
    }
    if (turn.status === "failed") {
      const codexErrorInfo = turn.error?.codexErrorInfo as JsonValue | null | undefined;
      this.terminalFailure.record({
        message: turn.error?.message,
        codexErrorInfo,
        rateLimits: this.options.readRecentRateLimits?.(),
        fallbackMessage: "codex app-server turn failed",
        promptErrorSource: compactionFailure ? "compaction" : "prompt",
      });
    }
    if (compactionFailure) {
      // Codex omits item/completed on failure, so the terminal turn must close
      // every active structural compaction for state and stream consumers.
      const failedCompactionItemIds = [...this.activeCompactionItemIds];
      for (const itemId of failedCompactionItemIds) {
        this.activeItemIds.delete(itemId);
        this.activeCompactionItemIds.delete(itemId);
        this.eventProjection.emitCompactionEnd(itemId, false);
      }
    }
    const turnItems = turn.items ?? [];
    // Upstream terminal summaries contain only the last assistant item. Keep
    // earlier unsettled deliveries at their producer instead of inferring them.
    const unsettledAsyncDeliveries = this.asyncDeliveryProjection.pending();
    // The final snapshot is authoritative when item notifications were omitted.
    // Only its last relevant tool may change the terminal presentation.
    const lastToolItem = turnItems.findLast(
      (item) =>
        matchesCodexSnapshotTurn(item, this.turnId) &&
        (item.type === "dynamicToolCall" || shouldClearTerminalPresentationForNativeItem(item)),
    );
    if (lastToolItem?.type !== "dynamicToolCall") {
      this.nativeToolLifecycleProjector.clearTerminalPresentationForNativeItem(lastToolItem);
    }
    for (const item of turnItems) {
      if (!this.asyncDeliveryProjection.allows(item)) {
        continue;
      }
      this.diagnostics.warnUnknownItemStatus(item);
      const asyncMessage = this.assistantProjection.recordSnapshotItem(item);
      if (asyncMessage) {
        await this.asyncDeliveryProjection.deliver(asyncMessage);
      }
      if (this.projectionClosed) {
        return;
      }
      this.reasoningProjection.recordItem(item);
      await this.settlement.project("media_projection", () =>
        this.generatedMediaProjection.recordNative(item),
      );
      if (this.projectionClosed) {
        return;
      }
      this.toolProgressProjection.recordToolMeta(item);
      this.toolProgressProjection.rememberCommandAggregateOutputEcho(item);
      await this.eventProjection.emitSnapshotOnlyNativeToolProgress({
        item,
        activeItemIds: this.activeItemIds,
        completedItemIds: this.completedItemIds,
        isActive: () => !this.projectionClosed,
      });
      if (this.projectionClosed) {
        return;
      }
      this.toolTranscriptProjection.recordNativeToolCall(item);
      const details = await this.toolTranscriptProjection.prepareNativeToolResultDetails(item);
      if (this.projectionClosed) {
        return;
      }
      this.toolTranscriptProjection.recordNativeToolResult(item, details);
      this.toolTranscriptProjection.emitAfterToolCallObservation(item);
      this.toolProgressProjection.emitToolResultSummary(item);
      this.toolProgressProjection.emitToolResultOutput(item);
    }
    this.toolProgressProjection.approvalTimeoutKinds.clear();
    for (const delivery of unsettledAsyncDeliveries) {
      if (this.projectionClosed) {
        return;
      }
      await this.asyncDeliveryProjection.deliver(delivery);
    }
    if (this.projectionClosed) {
      return;
    }
    this.assistantProjection.finalizeAnswerCandidate(turn);
    this.activeCompactionItemIds.clear();
    await this.reasoningProjection.maybeEndReasoning();
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
    await this.settlement.project("media_projection", () =>
      this.generatedMediaProjection.recordRaw(item),
    );
  }

  private isHookNotificationForCurrentThread(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turnId = params.turnId;
    return threadId === this.threadId && (turnId === this.turnId || turnId === null);
  }
}
