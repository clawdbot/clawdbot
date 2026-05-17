import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  classifyAgentHarnessTerminalOutcome,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  formatErrorMessage,
  formatToolAggregate,
  formatToolProgressOutput,
  inferToolMetaFromArgs,
  normalizeUsage,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeCompactionHook,
  TOOL_PROGRESS_OUTPUT_MAX_CHARS,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";
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
import { readRecentCodexRateLimits, rememberCodexRateLimits } from "./rate-limit-cache.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  resolveCodexToolProgressDetailMode,
  sanitizeCodexAgentEventRecord,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";
import { attachCodexMirrorIdentity, buildCodexUserPromptMessage } from "./transcript-mirror.js";

export type CodexAppServerToolTelemetry = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
};

export type CodexAppServerEventProjectorOptions = {
  nativePostToolUseRelayEnabled?: boolean;
  trajectoryRecorder?: CodexTrajectoryRecorder | null;
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const CURRENT_TOKEN_USAGE_KEYS = [
  "last",
  "current",
  "lastCall",
  "lastCallUsage",
  "lastTokenUsage",
  "last_token_usage",
] as const;

const CODEX_PROMPT_TOTAL_INPUT_KEYS = [
  "inputTokens",
  "input_tokens",
  "promptTokens",
  "prompt_tokens",
] as const;

const MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM = 20;
const TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS = 12_000;

type ToolTranscriptCallInput = {
  id: string;
  name: string;
  arguments?: unknown;
};

type ToolTranscriptResultInput = {
  id: string;
  name: string;
  text?: string;
  isError: boolean;
};

export class CodexAppServerEventProjector {
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantItemOrder: string[] = [];
  private readonly assistantPhaseByItem = new Map<string, string>();
  private readonly lastCommentaryProgressTextByItem = new Map<string, string>();
  private readonly reasoningTextByItem = new Map<string, string>();
  private readonly planTextByItem = new Map<string, string>();
  private readonly activeItemIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private readonly activeCompactionItemIds = new Set<string>();
  private readonly toolProgressTexts = new Set<string>();
  private readonly toolResultSummaryItemIds = new Set<string>();
  private readonly toolResultOutputItemIds = new Set<string>();
  private readonly toolResultOutputStreamedItemIds = new Set<string>();
  private readonly toolResultOutputDeltaState = new Map<
    string,
    { chars: number; messages: number; truncated: boolean }
  >();
  private readonly toolMetas = new Map<string, { toolName: string; meta?: string }>();
  private readonly toolTranscriptMessages: AgentMessage[] = [];
  private readonly toolTranscriptCallIds = new Set<string>();
  private readonly toolTranscriptResultIds = new Set<string>();
  private readonly nativeGeneratedMediaUrls = new Set<string>();
  private readonly diagnosticToolStartedAtByItem = new Map<string, number>();
  private readonly afterToolCallObservedItemIds = new Set<string>();
  private assistantStarted = false;
  private reasoningStarted = false;
  private reasoningEnded = false;
  private completedTurn: CodexTurn | undefined;
  private promptError: unknown;
  private promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
  private aborted = false;
  private tokenUsage: ReturnType<typeof normalizeUsage>;
  private guardianReviewCount = 0;
  private completedCompactionCount = 0;
  private latestRateLimits: JsonValue | undefined;
  private readonly nativeSubagentTaskMirror: CodexNativeSubagentTaskMirror;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexAppServerEventProjectorOptions = {},
  ) {
    this.nativeSubagentTaskMirror = new CodexNativeSubagentTaskMirror({
      parentThreadId: threadId,
      requesterSessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  }

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    try {
      this.nativeSubagentTaskMirror.handleNotification(notification);
    } catch (error) {
      embeddedAgentLog.warn("Failed to mirror Codex native subagent lifecycle event", {
        method: notification.method,
        error: formatErrorMessage(error),
      });
    }
    if (notification.method === "account/rateLimits/updated") {
      this.latestRateLimits = params;
      rememberCodexRateLimits(params);
      return;
    }
    if (isHookNotificationMethod(notification.method)) {
      if (!this.isHookNotificationForCurrentThread(params)) {
        return;
      }
    } else if (!this.isNotificationForTurn(params)) {
      return;
    }

    switch (notification.method) {
      case "item/agentMessage/delta":
        await this.handleAssistantDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.handleReasoningDelta(params);
        break;
      case "item/plan/delta":
        this.handlePlanDelta(params);
        break;
      case "turn/plan/updated":
        this.handleTurnPlanUpdated(params);
        break;
      case "item/started":
        await this.handleItemStarted(params);
        break;
      case "item/completed":
        await this.handleItemCompleted(params);
        break;
      case "item/commandExecution/outputDelta":
        this.handleOutputDelta(params, "bash");
        break;
      case "item/fileChange/outputDelta":
        this.handleOutputDelta(params, "apply_patch");
        break;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        this.handleGuardianReviewNotification(notification.method, params);
        break;
      case "hook/started":
      case "hook/completed":
        this.handleHookNotification(notification.method, params);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(params);
        break;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        break;
      case "rawResponseItem/completed":
        this.handleRawResponseItemCompleted(params);
        break;
      case "error":
        if (readBooleanAlias(params, ["willRetry", "will_retry"]) === true) {
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
    const assistantTexts = this.collectAssistantTexts();
    const reasoningText = collectTextValues(this.reasoningTextByItem).join("\n\n");
    const planText = collectTextValues(this.planTextByItem).join("\n\n");
    const lastAssistant =
      assistantTexts.length > 0
        ? this.createAssistantMessage(assistantTexts.join("\n\n"))
        : undefined;
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
    const messagesSnapshot: AgentMessage[] = [
      attachCodexMirrorIdentity(buildCodexUserPromptMessage(this.params), `${turnId}:prompt`),
    ];
    // Codex owns the canonical thread. These mirror records keep enough local
    // context for OpenClaw history, search, and future harness switching.
    if (reasoningText) {
      messagesSnapshot.push(
        attachCodexMirrorIdentity(
          this.createAssistantMirrorMessage("Codex reasoning", reasoningText),
          `${turnId}:reasoning`,
        ),
      );
    }
    if (planText) {
      messagesSnapshot.push(
        attachCodexMirrorIdentity(
          this.createAssistantMirrorMessage("Codex plan", planText),
          `${turnId}:plan`,
        ),
      );
    }
    messagesSnapshot.push(...this.toolTranscriptMessages);
    if (lastAssistant) {
      messagesSnapshot.push(attachCodexMirrorIdentity(lastAssistant, `${turnId}:assistant`));
    }
    const turnFailed = this.completedTurn?.status === "failed";
    const turnInterrupted = this.completedTurn?.status === "interrupted";
    const promptError =
      this.promptError ??
      (turnFailed ? (this.completedTurn?.error?.message ?? "codex app-server turn failed") : null);
    const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
      assistantTexts,
      reasoningText,
      planText,
      promptError,
      turnCompleted: Boolean(this.completedTurn),
    });
    return {
      aborted: this.aborted || turnInterrupted,
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
      toolMetas: [...this.toolMetas.values()],
      lastAssistant,
      didSendViaMessagingTool: toolTelemetry.didSendViaMessagingTool,
      messagingToolSentTexts: toolTelemetry.messagingToolSentTexts,
      messagingToolSentMediaUrls: toolTelemetry.messagingToolSentMediaUrls,
      messagingToolSentTargets: toolTelemetry.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: toolTelemetry.messagingToolSourceReplyPayloads ?? [],
      heartbeatToolResponse: toolTelemetry.heartbeatToolResponse,
      toolMediaUrls: this.buildToolMediaUrls(toolTelemetry),
      toolAudioAsVoice: toolTelemetry.toolAudioAsVoice,
      successfulCronAdds: toolTelemetry.successfulCronAdds,
      cloudCodeAssistFormatError: false,
      attemptUsage: this.tokenUsage,
      replayMetadata: {
        hadPotentialSideEffects: toolTelemetry.didSendViaMessagingTool,
        replaySafe: !toolTelemetry.didSendViaMessagingTool,
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
      didSendDeterministicApprovalPrompt: this.guardianReviewCount > 0 ? false : undefined,
    };
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    this.recordToolTranscriptCall({
      id: params.callId,
      name: params.tool,
      arguments: sanitizeCodexToolArguments(params.arguments),
    });
  }

  recordDynamicToolResult(params: {
    callId: string;
    tool: string;
    success: boolean;
    contentItems: CodexDynamicToolCallOutputContentItem[];
  }): void {
    this.recordToolTranscriptResult({
      id: params.callId,
      name: params.tool,
      text: collectDynamicToolContentText(params.contentItems),
      isError: !params.success,
    });
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

  private async handleAssistantDelta(params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    if (!this.assistantStarted) {
      this.assistantStarted = true;
      await this.params.onAssistantMessageStart?.();
    }
    this.rememberAssistantItem(itemId);
    const text = `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`;
    this.assistantTextByItem.set(itemId, text);
    if (this.isCommentaryAssistantItem(itemId)) {
      this.emitCommentaryProgress({ itemId, text });
    }
    // Codex app-server can emit multiple agentMessage items per turn, including
    // intermediate coordination/progress prose. Keep those deltas internal until
    // turn completion chooses the last assistant item as the user-visible reply.
  }

  private async handleReasoningDelta(params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "reasoning";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.reasoningStarted = true;
    this.reasoningTextByItem.set(itemId, `${this.reasoningTextByItem.get(itemId) ?? ""}${delta}`);
    await this.params.onReasoningStream?.({ text: delta });
  }

  private handlePlanDelta(params: JsonObject): void {
    const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "plan";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    const text = `${this.planTextByItem.get(itemId) ?? ""}${delta}`;
    this.planTextByItem.set(itemId, text);
    this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(text) });
  }

  private handleTurnPlanUpdated(params: JsonObject): void {
    const plan = Array.isArray(params.plan)
      ? params.plan.flatMap((entry) => {
          if (!isJsonObject(entry)) {
            return [];
          }
          const step = readString(entry, "step");
          const status = readString(entry, "status");
          if (!step) {
            return [];
          }
          return status ? [`${step} (${status})`] : [step];
        })
      : undefined;
    this.emitPlanUpdate({
      explanation: readNullableString(params, "explanation"),
      steps: plan,
    });
  }

  private async handleItemStarted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    const itemId = item?.id ?? readString(params, "itemId") ?? readString(params, "id");
    this.rememberAssistantPhase(item);
    if (itemId) {
      this.activeItemIds.add(itemId);
    }
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.add(itemId);
      await runAgentHarnessBeforeCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: await this.readMirroredSessionMessages(),
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
    this.emitStandardItemEvent({ phase: "start", item });
    this.emitNormalizedToolItemEvent({ phase: "start", item });
    this.recordNativeToolTranscriptCall(item);
    this.emitToolResultSummary(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "started", itemId, type: item?.type },
    });
  }

  private async handleItemCompleted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    const itemId = item?.id ?? readString(params, "itemId") ?? readString(params, "id");
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
    }
    this.rememberAssistantPhase(item);
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text) {
      this.rememberAssistantItem(item.id);
      this.assistantTextByItem.set(item.id, item.text);
      if (this.isCommentaryAssistantItem(item.id)) {
        this.emitCommentaryProgress({ itemId: item.id, text: item.text });
      }
    }
    this.recordNativeGeneratedMedia(item);
    if (item?.type === "plan" && typeof item.text === "string" && item.text) {
      this.planTextByItem.set(item.id, item.text);
      this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(item.text) });
    }
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.delete(itemId);
      this.completedCompactionCount += 1;
      await runAgentHarnessAfterCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: await this.readMirroredSessionMessages(),
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
    this.recordToolMeta(item);
    this.emitStandardItemEvent({ phase: "end", item });
    this.emitNormalizedToolItemEvent({ phase: "result", item });
    this.recordNativeToolTranscriptCall(item);
    this.recordNativeToolTranscriptResult(item);
    this.emitToolResultSummary(item);
    this.emitToolResultOutput(item);
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "completed", itemId, type: item?.type },
    });
  }

  private handleTokenUsage(params: JsonObject): void {
    const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
    const current =
      (tokenUsage ? readFirstJsonObject(tokenUsage, CURRENT_TOKEN_USAGE_KEYS) : undefined) ??
      readFirstJsonObject(params, CURRENT_TOKEN_USAGE_KEYS);
    if (!current) {
      return;
    }
    const usage = normalizeCodexTokenUsage(current);
    if (usage) {
      this.tokenUsage = usage;
    }
  }

  private handleGuardianReviewNotification(method: string, params: JsonObject): void {
    this.guardianReviewCount += 1;
    const review = isJsonObject(params.review) ? params.review : undefined;
    const action = isJsonObject(params.action) ? params.action : undefined;
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        method,
        phase: method.endsWith("/started") ? "started" : "completed",
        reviewId: readString(params, "reviewId"),
        targetItemId: readNullableString(params, "targetItemId"),
        decisionSource: readString(params, "decisionSource"),
        status: review ? readString(review, "status") : undefined,
        riskLevel: review ? readString(review, "riskLevel") : undefined,
        userAuthorization: review ? readString(review, "userAuthorization") : undefined,
        rationale: review ? readNullableString(review, "rationale") : undefined,
        actionType: action ? readString(action, "type") : undefined,
      },
    });
  }

  private handleHookNotification(method: string, params: JsonObject): void {
    const run = isJsonObject(params.run) ? params.run : undefined;
    if (!run) {
      return;
    }
    const durationMs = readNumber(run, "durationMs");
    const entries = readHookOutputEntries(run.entries);
    const hookTurnId = readNullableString(params, "turnId");
    this.emitAgentEvent({
      stream: "codex_app_server.hook",
      data: {
        phase: method === "hook/started" ? "started" : "completed",
        threadId: this.threadId,
        turnId: hookTurnId === undefined ? this.turnId : hookTurnId,
        hookRunId: readString(run, "id"),
        eventName: readString(run, "eventName"),
        handlerType: readString(run, "handlerType"),
        executionMode: readString(run, "executionMode"),
        scope: readString(run, "scope"),
        source: readString(run, "source"),
        sourcePath: readString(run, "sourcePath"),
        status: readString(run, "status"),
        statusMessage: readNullableString(run, "statusMessage"),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(entries.length > 0 ? { entries } : {}),
      },
    });
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const turn = readTurn(params.turn);
    if (!turn || turn.id !== this.turnId) {
      return;
    }
    this.completedTurn = turn;
    if (turn.status === "interrupted") {
      this.aborted = true;
    }
    if (turn.status === "failed") {
      this.promptError =
        formatCodexUsageLimitErrorMessage({
          message: turn.error?.message,
          codexErrorInfo: turn.error?.codexErrorInfo as JsonValue | null | undefined,
          rateLimits: this.latestRateLimits ?? readRecentCodexRateLimits(),
        }) ??
        turn.error?.message ??
        "codex app-server turn failed";
      this.promptErrorSource = "prompt";
    }
    for (const item of turn.items ?? []) {
      this.rememberAssistantPhase(item);
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
        this.rememberAssistantItem(item.id);
        this.assistantTextByItem.set(item.id, item.text);
      }
      this.recordNativeGeneratedMedia(item);
      if (item.type === "plan" && typeof item.text === "string" && item.text) {
        this.planTextByItem.set(item.id, item.text);
        this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(item.text) });
      }
      this.recordToolMeta(item);
      this.emitSnapshotOnlyNativeToolProgress(item);
      this.recordNativeToolTranscriptCall(item);
      this.recordNativeToolTranscriptResult(item);
      this.emitAfterToolCallObservation(item);
      this.emitToolResultSummary(item);
      this.emitToolResultOutput(item);
    }
    this.activeCompactionItemIds.clear();
    await this.maybeEndReasoning();
  }

  private emitSnapshotOnlyNativeToolProgress(item: CodexThreadItem): void {
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
      this.emitStandardItemEvent({ phase: "start", item });
      this.emitNormalizedToolItemEvent({ phase: "start", item });
    }
    this.activeItemIds.delete(item.id);
    this.emitStandardItemEvent({ phase: "end", item });
    this.emitNormalizedToolItemEvent({ phase: "result", item });
    this.completedItemIds.add(item.id);
  }

  private isCurrentTurnSnapshotItem(item: CodexThreadItem): boolean {
    const itemTurnId = readItemString(item, "turnId") ?? readItemString(item, "turn_id");
    return itemTurnId === undefined || itemTurnId === this.turnId;
  }

  private handleOutputDelta(params: JsonObject, toolName: string): void {
    const itemId = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (!itemId || !delta || !this.shouldEmitToolOutput()) {
      return;
    }
    const state = this.toolResultOutputDeltaState.get(itemId) ?? {
      chars: 0,
      messages: 0,
      truncated: false,
    };
    if (state.truncated) {
      return;
    }
    const remainingChars = Math.max(0, TOOL_PROGRESS_OUTPUT_MAX_CHARS - state.chars);
    const remainingMessages = Math.max(0, MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM - state.messages);
    if (remainingChars === 0 || remainingMessages === 0) {
      state.truncated = true;
      this.toolResultOutputDeltaState.set(itemId, state);
      this.emitToolResultMessage({
        itemId,
        text: formatToolOutput(toolName, undefined, "(output truncated)"),
      });
      return;
    }
    const chunk = delta.length > remainingChars ? delta.slice(0, remainingChars) : delta;
    state.chars += chunk.length;
    state.messages += 1;
    const reachedLimit =
      delta.length > remainingChars ||
      state.chars >= TOOL_PROGRESS_OUTPUT_MAX_CHARS ||
      state.messages >= MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM;
    if (reachedLimit) {
      state.truncated = true;
    }
    this.toolResultOutputDeltaState.set(itemId, state);
    this.toolResultOutputStreamedItemIds.add(itemId);
    this.emitToolResultMessage({
      itemId,
      text: formatToolOutput(
        toolName,
        undefined,
        reachedLimit ? `${chunk}\n...(truncated)...` : chunk,
      ),
    });
  }

  private handleRawResponseItemCompleted(params: JsonObject): void {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item || readString(item, "role") !== "assistant") {
      return;
    }
    const text = extractRawAssistantText(item);
    if (!text) {
      return;
    }
    const itemId = readString(item, "id") ?? `raw-assistant-${this.assistantItemOrder.length + 1}`;
    const phase = readString(item, "phase");
    if (phase) {
      this.assistantPhaseByItem.set(itemId, phase);
    }
    this.rememberAssistantItem(itemId);
    this.assistantTextByItem.set(itemId, text);
    if (phase === "commentary") {
      this.emitCommentaryProgress({ itemId, text });
    }
  }

  private recordNativeGeneratedMedia(item: CodexThreadItem | undefined): void {
    if (item?.type !== "imageGeneration") {
      return;
    }
    const savedPath = readItemString(item, "savedPath")?.trim();
    if (savedPath) {
      this.nativeGeneratedMediaUrls.add(savedPath);
    }
  }

  private buildToolMediaUrls(toolTelemetry: CodexAppServerToolTelemetry): string[] | undefined {
    const mediaUrls = new Set(
      toolTelemetry.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? [],
    );
    if ((toolTelemetry.messagingToolSentMediaUrls?.length ?? 0) === 0) {
      for (const mediaUrl of this.nativeGeneratedMediaUrls) {
        mediaUrls.add(mediaUrl);
      }
    }
    return mediaUrls.size > 0 ? [...mediaUrls] : toolTelemetry.toolMediaUrls;
  }

  private async maybeEndReasoning(): Promise<void> {
    if (!this.reasoningStarted || this.reasoningEnded) {
      return;
    }
    this.reasoningEnded = true;
    await this.params.onReasoningEnd?.();
  }

  private emitPlanUpdate(params: { explanation?: string | null; steps?: string[] }): void {
    if (!params.explanation && (!params.steps || params.steps.length === 0)) {
      return;
    }
    this.emitAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "codex-app-server",
        ...(params.explanation ? { explanation: params.explanation } : {}),
        ...(params.steps && params.steps.length > 0 ? { steps: params.steps } : {}),
      },
    });
  }

  private rememberAssistantPhase(item: CodexThreadItem | undefined): void {
    if (item?.type !== "agentMessage") {
      return;
    }
    const phase = readItemString(item, "phase");
    if (phase) {
      this.assistantPhaseByItem.set(item.id, phase);
    }
  }

  private isCommentaryAssistantItem(itemId: string): boolean {
    return this.assistantPhaseByItem.get(itemId) === "commentary";
  }

  private emitCommentaryProgress(params: { itemId: string; text: string }): void {
    const progressText = params.text.replace(/\s+/g, " ").trim();
    if (
      !progressText ||
      this.lastCommentaryProgressTextByItem.get(params.itemId) === progressText
    ) {
      return;
    }
    this.lastCommentaryProgressTextByItem.set(params.itemId, progressText);
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: params.itemId,
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText,
        source: "codex-app-server",
      },
    });
  }

  private emitStandardItemEvent(params: {
    phase: "start" | "end";
    item: CodexThreadItem | undefined;
  }): void {
    const { item } = params;
    if (!item) {
      return;
    }
    const kind = itemKind(item);
    if (!kind) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    const suppressChannelProgress = shouldSuppressChannelProgressForItem(item);
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: item.id,
        phase: params.phase,
        kind,
        title: itemTitle(item),
        status: params.phase === "start" ? "running" : itemStatus(item),
        ...(itemName(item) ? { name: itemName(item) } : {}),
        ...(meta ? { meta } : {}),
        ...(suppressChannelProgress ? { suppressChannelProgress: true } : {}),
      },
    });
  }

  private emitNormalizedToolItemEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem | undefined;
  }): void {
    const { item } = params;
    if (!item || !shouldSynthesizeToolProgressForItem(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    const args = params.phase === "start" ? itemToolArgs(item) : undefined;
    const status = params.phase === "result" ? itemStatus(item) : "running";
    this.recordToolTrajectoryEvent({ phase: params.phase, item, name, args, status });
    this.emitDiagnosticToolExecutionEvent({ phase: params.phase, item, name, status });
    this.emitAgentEvent({
      stream: "tool",
      data: {
        phase: params.phase,
        name,
        itemId: item.id,
        toolCallId: item.id,
        ...(meta ? { meta } : {}),
        ...(args ? { args } : {}),
        ...(params.phase === "result"
          ? {
              status,
              isError: isNonSuccessItemStatus(status),
              ...itemToolResult(item),
            }
          : {}),
      },
    });
    if (params.phase === "result") {
      this.emitAfterToolCallObservation(item);
    }
  }

  private recordToolTrajectoryEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    name: string;
    args?: Record<string, unknown>;
    status: ReturnType<typeof itemStatus>;
  }): void {
    if (params.phase === "start") {
      this.options.trajectoryRecorder?.recordEvent("tool.call", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: params.item.id,
        toolCallId: params.item.id,
        name: params.name,
        arguments: params.args,
      });
      return;
    }
    const toolResult = itemToolResult(params.item).result;
    const output = itemOutputText(params.item);
    this.options.trajectoryRecorder?.recordEvent("tool.result", {
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: params.item.id,
      toolCallId: params.item.id,
      name: params.name,
      status: params.status,
      isError: isNonSuccessItemStatus(params.status),
      ...(toolResult ? { result: toolResult } : {}),
      ...(output ? { output } : {}),
    });
  }

  private emitDiagnosticToolExecutionEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    name: string;
    status: ReturnType<typeof itemStatus>;
  }): void {
    const base = {
      runId: this.params.runId,
      sessionId: this.params.sessionId,
      sessionKey: this.params.sessionKey,
      toolName: params.name,
      toolCallId: params.item.id,
    };
    if (params.phase === "start") {
      this.diagnosticToolStartedAtByItem.set(params.item.id, Date.now());
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...base,
      });
      return;
    }

    const startedAt = this.diagnosticToolStartedAtByItem.get(params.item.id);
    this.diagnosticToolStartedAtByItem.delete(params.item.id);
    const itemDurationMs =
      typeof params.item.durationMs === "number" ? params.item.durationMs : undefined;
    const durationMs =
      itemDurationMs ?? (startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt));
    const terminalEvent =
      params.status === "blocked"
        ? {
            type: "tool.execution.blocked" as const,
            reason: "codex_native_tool_blocked",
            deniedReason: "codex_native_tool_blocked",
          }
        : params.status === "failed"
          ? {
              type: "tool.execution.error" as const,
              durationMs,
              errorCategory: "codex_native_tool_error",
            }
          : {
              type: "tool.execution.completed" as const,
              durationMs,
            };
    emitTrustedDiagnosticEvent({ ...base, ...terminalEvent });
  }

  private emitAfterToolCallObservation(item: CodexThreadItem): void {
    if (!this.shouldEmitAfterToolCallObservation(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    const status = itemStatus(item);
    if (status === "running") {
      return;
    }
    this.afterToolCallObservedItemIds.add(item.id);
    const result = itemToolResult(item).result;
    const error = itemToolError(item, status);
    const startedAt =
      typeof item.durationMs === "number" ? Date.now() - Math.max(0, item.durationMs) : undefined;
    const hookParams = {
      toolName: name,
      toolCallId: item.id,
      runId: this.params.runId,
      agentId: this.params.agentId,
      sessionId: this.params.sessionId,
      sessionKey: this.params.sessionKey,
      startArgs: itemToolArgs(item) ?? {},
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    setImmediate(() => {
      void runAgentHarnessAfterToolCallHook(hookParams);
    });
  }

  private shouldEmitAfterToolCallObservation(item: CodexThreadItem): boolean {
    if (
      !shouldSynthesizeToolProgressForItem(item) ||
      this.afterToolCallObservedItemIds.has(item.id)
    ) {
      return false;
    }
    if (this.options.nativePostToolUseRelayEnabled && isNativePostToolUseRelayItem(item)) {
      return false;
    }
    return true;
  }

  private emitToolResultSummary(item: CodexThreadItem | undefined): void {
    if (!item || !this.params.onToolResult || !this.shouldEmitToolResult()) {
      return;
    }
    const itemId = item.id;
    if (this.toolResultSummaryItemIds.has(itemId)) {
      return;
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    this.toolResultSummaryItemIds.add(itemId);
    const meta = itemMeta(item, this.toolProgressDetailMode());
    this.emitToolResultMessage({
      itemId,
      text: formatToolSummary(toolName, meta),
    });
  }

  private emitToolResultOutput(item: CodexThreadItem | undefined): void {
    if (!item || !this.params.onToolResult || !this.shouldEmitToolOutput()) {
      return;
    }
    const itemId = item.id;
    if (this.toolResultOutputItemIds.has(itemId)) {
      return;
    }
    if (this.toolResultOutputStreamedItemIds.has(itemId)) {
      return;
    }
    const toolName = itemName(item);
    const output = itemOutputText(item);
    if (!toolName || !output) {
      return;
    }
    this.emitToolResultMessage({
      itemId,
      text: formatToolOutput(toolName, itemMeta(item, this.toolProgressDetailMode()), output),
      finalOutput: true,
    });
  }

  private emitToolResultMessage(params: {
    itemId: string;
    text: string;
    finalOutput?: boolean;
  }): void {
    const text = params.text.trim();
    if (!text) {
      return;
    }
    this.toolProgressTexts.add(text);
    if (params.finalOutput) {
      this.toolResultOutputItemIds.add(params.itemId);
    }
    try {
      void Promise.resolve(this.params.onToolResult?.({ text })).catch(() => {
        // Tool progress delivery is best-effort and should not affect the turn.
      });
    } catch {
      // Tool progress delivery is best-effort and should not affect the turn.
    }
  }

  private shouldEmitToolResult(): boolean {
    return typeof this.params.shouldEmitToolResult === "function"
      ? this.params.shouldEmitToolResult()
      : this.params.verboseLevel === "on" || this.params.verboseLevel === "full";
  }

  private shouldEmitToolOutput(): boolean {
    return typeof this.params.shouldEmitToolOutput === "function"
      ? this.params.shouldEmitToolOutput()
      : this.params.verboseLevel === "full";
  }

  private toolProgressDetailMode(): ToolProgressDetailMode {
    return resolveCodexToolProgressDetailMode(this.params.toolProgressDetail);
  }

  private recordToolMeta(item: CodexThreadItem | undefined): void {
    if (!item) {
      return;
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    this.toolMetas.set(item.id, {
      toolName,
      ...(meta ? { meta } : {}),
    });
  }

  private recordNativeToolTranscriptCall(item: CodexThreadItem | undefined): void {
    if (!item || !shouldSynthesizeToolProgressForItem(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    this.recordToolTranscriptCall({
      id: item.id,
      name,
      arguments: itemToolArgs(item),
    });
  }

  private recordNativeToolTranscriptResult(item: CodexThreadItem | undefined): void {
    if (!item || !shouldSynthesizeToolProgressForItem(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    this.recordToolTranscriptResult({
      id: item.id,
      name,
      text: itemTranscriptResultText(item),
      isError: isNonSuccessItemStatus(itemStatus(item)),
    });
  }

  private recordToolTranscriptCall(params: ToolTranscriptCallInput): void {
    if (!params.id || !params.name || this.toolTranscriptCallIds.has(params.id)) {
      return;
    }
    this.toolTranscriptCallIds.add(params.id);
    this.toolTranscriptMessages.push(
      attachCodexMirrorIdentity(
        this.createToolCallMessage(params),
        `${this.turnId}:tool:${params.id}:call`,
      ),
    );
  }

  private recordToolTranscriptResult(params: ToolTranscriptResultInput): void {
    if (!params.id || !params.name || this.toolTranscriptResultIds.has(params.id)) {
      return;
    }
    this.toolTranscriptResultIds.add(params.id);
    this.toolTranscriptMessages.push(
      attachCodexMirrorIdentity(
        this.createToolResultMessage(params),
        `${this.turnId}:tool:${params.id}:result`,
      ),
    );
  }

  private formatCodexErrorMessage(params: JsonObject): string | undefined {
    const error = isJsonObject(params.error) ? params.error : undefined;
    return (
      formatCodexUsageLimitErrorMessage({
        message: error ? readString(error, "message") : undefined,
        codexErrorInfo: error?.codexErrorInfo,
        rateLimits: this.latestRateLimits ?? readRecentCodexRateLimits(),
      }) ?? readCodexErrorNotificationMessage(params)
    );
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

  private collectAssistantTexts(): string[] {
    const finalText = this.resolveFinalAssistantText();
    return finalText ? [finalText] : [];
  }

  private resolveFinalAssistantText(): string | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (this.assistantPhaseByItem.get(itemId) === "commentary") {
        continue;
      }
      if (text && !this.toolProgressTexts.has(text)) {
        return text;
      }
    }
    return undefined;
  }

  private rememberAssistantItem(itemId: string): void {
    if (!itemId || this.assistantItemOrder.includes(itemId)) {
      return;
    }
    this.assistantItemOrder.push(itemId);
  }

  private async readMirroredSessionMessages(): Promise<AgentMessage[]> {
    return (await readCodexMirroredSessionHistoryMessages(this.params.sessionFile)) ?? [];
  }

  private createAssistantMessage(text: string): AssistantMessage {
    const attribution = resolveCodexLocalRuntimeAttribution(this.params);
    const usage: Usage = this.tokenUsage
      ? {
          input: this.tokenUsage.input ?? 0,
          output: this.tokenUsage.output ?? 0,
          cacheRead: this.tokenUsage.cacheRead ?? 0,
          cacheWrite: this.tokenUsage.cacheWrite ?? 0,
          totalTokens:
            this.tokenUsage.total ??
            (this.tokenUsage.input ?? 0) +
              (this.tokenUsage.output ?? 0) +
              (this.tokenUsage.cacheRead ?? 0) +
              (this.tokenUsage.cacheWrite ?? 0),
          cost: ZERO_USAGE.cost,
        }
      : ZERO_USAGE;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: attribution.api ?? "openai-codex-responses",
      provider: attribution.provider,
      model: this.params.modelId,
      usage,
      stopReason: this.aborted ? "aborted" : this.promptError ? "error" : "stop",
      errorMessage: this.promptError ? formatErrorMessage(this.promptError) : undefined,
      timestamp: Date.now(),
    };
  }

  private createAssistantMirrorMessage(title: string, text: string): AssistantMessage {
    const attribution = resolveCodexLocalRuntimeAttribution(this.params);
    return {
      role: "assistant",
      content: [{ type: "text", text: `${title}:\n${text}` }],
      api: attribution.api ?? "openai-codex-responses",
      provider: attribution.provider,
      model: this.params.modelId,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  private createToolCallMessage(params: ToolTranscriptCallInput): AgentMessage {
    const args = normalizeToolTranscriptArguments(params.arguments);
    const attribution = resolveCodexLocalRuntimeAttribution(this.params);
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: params.id,
          name: params.name,
          arguments: args,
          input: args,
        },
      ],
      api: attribution.api ?? "openai-codex-responses",
      provider: attribution.provider,
      model: this.params.modelId,
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  private createToolResultMessage(params: ToolTranscriptResultInput): AgentMessage {
    const text = truncateToolTranscriptText(params.text?.trim() || toolResultStatusText(params));
    return {
      role: "toolResult",
      toolCallId: params.id,
      toolName: params.name,
      isError: params.isError,
      content: [
        {
          type: "toolResult",
          id: params.id,
          name: params.name,
          toolName: params.name,
          toolCallId: params.id,
          toolUseId: params.id,
          tool_use_id: params.id,
          content: text,
          text,
        },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }

  private isNotificationForTurn(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turnId = readNotificationTurnId(params);
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

function readNotificationTurnId(record: JsonObject): string | undefined {
  return readString(record, "turnId") ?? readNestedTurnId(record);
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = record.turn;
  return isJsonObject(turn) ? readString(turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(record: JsonObject, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: JsonObject, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readBooleanAlias(record: JsonObject, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = readBoolean(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readCodexErrorNotificationMessage(record: JsonObject): string | undefined {
  const error = record.error;
  if (isJsonObject(error)) {
    return readString(error, "message") ?? readString(error, "error");
  }
  return readString(record, "message");
}

function readHookOutputEntries(
  value: JsonValue | undefined,
): Array<{ kind?: string; text: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }
    const text = readString(entry, "text");
    if (!text) {
      return [];
    }
    const kind = readString(entry, "kind");
    return [{ ...(kind ? { kind } : {}), text }];
  });
}

function readFirstJsonObject(record: JsonObject, keys: readonly string[]): JsonObject | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isJsonObject(value)) {
      return value;
    }
  }
  return undefined;
}

function readNumberAlias(record: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeCodexTokenUsage(record: JsonObject): ReturnType<typeof normalizeUsage> {
  const promptTotalInput = readNumberAlias(record, CODEX_PROMPT_TOTAL_INPUT_KEYS);
  const cacheRead = readNumberAlias(record, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheRead",
    "cache_read",
    "cache_read_input_tokens",
    "cached_tokens",
  ]);
  const input =
    promptTotalInput !== undefined && cacheRead !== undefined
      ? Math.max(0, promptTotalInput - cacheRead)
      : (promptTotalInput ?? readNumber(record, "input"));

  return normalizeUsage({
    input,
    output: readNumberAlias(record, ["outputTokens", "output_tokens", "output"]),
    cacheRead,
    cacheWrite: readNumberAlias(record, [
      "cacheWrite",
      "cache_write",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ]),
    total: readNumberAlias(record, ["totalTokens", "total_tokens", "total"]),
  });
}

function splitPlanText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0);
}

function collectTextValues(map: Map<string, string>): string[] {
  return [...map.values()].filter((text) => text.trim().length > 0);
}

function extractRawAssistantText(item: JsonObject): string | undefined {
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const type = readString(entry, "type");
      if (type !== "output_text" && type !== "text") {
        return [];
      }
      const value = readString(entry, "text");
      return value ? [value] : [];
    })
    .join("");
  return text.trim() || undefined;
}

function itemKind(
  item: CodexThreadItem,
): "tool" | "command" | "patch" | "search" | "analysis" | undefined {
  switch (item.type) {
    case "dynamicToolCall":
    case "mcpToolCall":
      return "tool";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "patch";
    case "webSearch":
      return "search";
    case "reasoning":
    case "contextCompaction":
      return "analysis";
    default:
      return undefined;
  }
}

function itemTitle(item: CodexThreadItem): string {
  switch (item.type) {
    case "commandExecution":
      return "Command";
    case "fileChange":
      return "File change";
    case "mcpToolCall":
      return "MCP tool";
    case "dynamicToolCall":
      return "Tool";
    case "webSearch":
      return "Web search";
    case "contextCompaction":
      return "Context compaction";
    case "reasoning":
      return "Reasoning";
    default:
      return item.type;
  }
}

function itemStatus(item: CodexThreadItem): "completed" | "failed" | "running" | "blocked" {
  const status = readItemString(item, "status");
  if (status === "failed") {
    return "failed";
  }
  if (status === "declined") {
    return "blocked";
  }
  if (status === "inProgress" || status === "running") {
    return "running";
  }
  return "completed";
}

function isNonSuccessItemStatus(status: ReturnType<typeof itemStatus>): boolean {
  return status === "failed" || status === "blocked";
}

function itemName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
    return item.tool;
  }
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    const server = typeof item.server === "string" ? item.server : undefined;
    return server ? `${server}.${item.tool}` : item.tool;
  }
  if (item.type === "commandExecution") {
    return "bash";
  }
  if (item.type === "fileChange") {
    return "apply_patch";
  }
  if (item.type === "webSearch") {
    return "web_search";
  }
  return undefined;
}

function shouldSynthesizeToolProgressForItem(item: CodexThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "webSearch":
    case "mcpToolCall":
      return true;
    default:
      return false;
  }
}

function isNativePostToolUseRelayItem(item: CodexThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
      return true;
    default:
      return false;
  }
}

function shouldSuppressChannelProgressForItem(item: CodexThreadItem): boolean {
  if (shouldSynthesizeToolProgressForItem(item)) {
    return true;
  }
  // Dynamic OpenClaw tool requests are emitted at the item/tool/call request
  // boundary in run-attempt.ts. Re-emitting item notifications to channels can
  // duplicate start/result progress when the app-server sends both signals.
  return item.type === "dynamicToolCall";
}

function itemToolArgs(item: CodexThreadItem): Record<string, unknown> | undefined {
  if (item.type === "commandExecution") {
    return sanitizeCodexAgentEventRecord({
      command: item.command,
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    });
  }
  if (item.type === "fileChange") {
    return sanitizeCodexAgentEventRecord({
      changes: itemFileChanges(item),
    });
  }
  if (item.type === "webSearch" && typeof item.query === "string") {
    return sanitizeCodexAgentEventRecord({ query: item.query });
  }
  if (item.type === "mcpToolCall") {
    return sanitizeCodexToolArguments(item.arguments);
  }
  return undefined;
}

function itemToolResult(item: CodexThreadItem): { result?: Record<string, unknown> } {
  if (item.type === "commandExecution") {
    return {
      result: sanitizeCodexAgentEventRecord({
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      }),
    };
  }
  if (item.type === "fileChange") {
    return {
      result: sanitizeCodexAgentEventRecord({
        status: item.status,
        changes: itemFileChanges(item),
      }),
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      result: sanitizeCodexAgentEventRecord({
        status: item.status,
        durationMs: item.durationMs,
        ...(item.error ? { error: item.error } : {}),
        ...(item.result ? { result: item.result } : {}),
      }),
    };
  }
  if (item.type === "webSearch") {
    return { result: sanitizeCodexAgentEventRecord({ status: "completed" }) };
  }
  return {};
}

function itemFileChanges(item: CodexThreadItem): Array<{ path: string; kind: string }> {
  return Array.isArray(item.changes)
    ? item.changes.map((change) => ({ path: change.path, kind: change.kind }))
    : [];
}

function itemToolError(
  item: CodexThreadItem,
  status: ReturnType<typeof itemStatus>,
): string | undefined {
  if (status === "blocked") {
    return "codex native tool blocked";
  }
  if (status !== "failed") {
    return undefined;
  }
  return itemOutputText(item) ?? "codex native tool failed";
}

function itemMeta(
  item: CodexThreadItem,
  detailMode: ToolProgressDetailMode = "explain",
): string | undefined {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return inferToolMetaFromArgs(
      "exec",
      {
        command: item.command,
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      },
      { detailMode },
    );
  }
  if (item.type === "webSearch" && typeof item.query === "string") {
    return item.query;
  }
  const toolName = itemName(item);
  if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && toolName) {
    return inferToolMetaFromArgs(toolName, item.arguments, { detailMode });
  }
  return undefined;
}

function itemOutputText(item: CodexThreadItem): string | undefined {
  if (item.type === "commandExecution") {
    return item.aggregatedOutput?.trim() || undefined;
  }
  if (item.type === "dynamicToolCall") {
    return collectDynamicToolContentText(item.contentItems).trim() || undefined;
  }
  if (item.type === "mcpToolCall") {
    if (item.error) {
      return stringifyJsonValue(item.error);
    }
    return item.result ? stringifyJsonValue(item.result) : undefined;
  }
  return undefined;
}

function itemTranscriptResultText(item: CodexThreadItem): string | undefined {
  const output = itemOutputText(item);
  if (output) {
    return output;
  }
  const result = itemToolResult(item).result;
  return result ? stringifyJsonValue(result) : itemStatus(item);
}

function normalizeToolTranscriptArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function collectDynamicToolContentText(contentItems: CodexThreadItem["contentItems"]): string {
  if (!Array.isArray(contentItems)) {
    return "";
  }
  return contentItems
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const text = readString(entry, "text");
      return text ? [text] : [];
    })
    .join("\n");
}

function truncateToolTranscriptText(text: string): string {
  if (text.length <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS)}\n...(truncated)...`;
}

function toolResultStatusText(params: ToolTranscriptResultInput): string {
  return params.isError ? `${params.name} failed` : `${params.name} completed`;
}

function stringifyJsonValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function formatToolSummary(toolName: string, meta?: string): string {
  const trimmedMeta = meta?.trim();
  return formatToolAggregate(toolName, trimmedMeta ? [trimmedMeta] : undefined, {
    markdown: true,
  });
}

function formatToolOutput(toolName: string, meta: string | undefined, output: string): string {
  const formattedOutput = formatToolProgressOutput(output);
  if (!formattedOutput) {
    return formatToolSummary(toolName, meta);
  }
  const fence = markdownFenceForText(formattedOutput);
  return `${formatToolSummary(toolName, meta)}\n${fence}txt\n${formattedOutput}\n${fence}`;
}

function markdownFenceForText(text: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}

function readItemString(item: CodexThreadItem, key: string): string | undefined {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readItem(value: JsonValue | undefined): CodexThreadItem | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  if (!type || !id) {
    return undefined;
  }
  return value as CodexThreadItem;
}

function readTurn(value: JsonValue | undefined): CodexTurn | undefined {
  return readCodexTurn(value);
}
