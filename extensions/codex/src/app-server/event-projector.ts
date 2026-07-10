// Codex plugin module implements event projector behavior.
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
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";
import {
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
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

export type CodexAppServerEventProjectorOptions = {
  nativePostToolUseRelayEnabled?: boolean;
  onNativeToolResultRecorded?: () => void | Promise<void>;
  readRecentRateLimits?: () => JsonValue | undefined;
  runAbortSignal?: AbortSignal;
  trajectoryRecorder?: CodexTrajectoryRecorder | null;
  onContextCompacted?: () => void;
};

type CodexNativeToolLifecycleContext = Pick<
  EmbeddedRunAttemptParams,
  "agentId" | "runId" | "sessionId" | "sessionKey"
>;

type CodexNativeToolLifecycleProjectorOptions = {
  runAbortSignal?: AbortSignal;
};

type CodexNativeToolAuditStatus = ReturnType<typeof itemStatus> | "cancelled" | "unknown";
type CodexNativeToolUnfinishedStatus = Extract<CodexNativeToolAuditStatus, "failed" | "unknown">;
type CodexNativePreToolUseFailureRecord = {
  failure: CodexNativePreToolUseFailure;
  terminalReason: CodexNativePreToolUseFailure["disposition"];
};

/** Projects metadata-only lifecycle diagnostics for native tool items. */
export class CodexNativeToolLifecycleProjector {
  private readonly startedAtByItem = new Map<string, number>();
  private readonly activeItems = new Map<
    string,
    { toolName: string; unfinishedStatus: CodexNativeToolUnfinishedStatus }
  >();
  private readonly webSearchCompletionByItem = new Map<
    string,
    { runWasAborted: boolean; sourceTimestampMs?: number }
  >();
  private readonly completedItemIds = new Set<string>();
  private readonly approvalFailureDispositionByItem = new Map<
    string,
    Exclude<BeforeToolCallFailureDisposition, "blocked">
  >();
  private readonly preToolUseFailureByItem = new Map<string, CodexNativePreToolUseFailureRecord>();
  private finalized = false;

  constructor(
    private readonly context: CodexNativeToolLifecycleContext,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexNativeToolLifecycleProjectorOptions = {},
  ) {}

  handleNotification(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (
      !params ||
      readCodexNotificationThreadId(params) !== this.threadId ||
      readCodexNotificationTurnId(params) !== this.turnId
    ) {
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = readCodexTurn(params.turn);
      if (!turn || turn.id !== this.turnId) {
        return;
      }
      for (const item of turn.items ?? []) {
        this.recordSnapshotItem(item);
      }
      return;
    }
    if (notification.method === "rawResponseItem/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (item) {
        this.recordRawWebSearchResult(item);
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const item = readItem(params.item);
    if (!item) {
      return;
    }
    this.recordItem({
      phase: notification.method === "item/started" ? "start" : "result",
      item,
      sourceTimestampMs: asDateTimestampMs(
        notification.method === "item/started" ? params.startedAtMs : params.completedAtMs,
      ),
    });
  }

  recordItem(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    sourceTimestampMs?: number;
  }): void {
    const toolName = auditNativeToolName(params.item);
    if (!toolName || this.completedItemIds.has(params.item.id)) {
      return;
    }
    if (params.phase === "start") {
      this.recordStarted(
        params.item.id,
        toolName,
        auditNativeToolUnfinishedStatus(params.item),
        params.sourceTimestampMs,
      );
      return;
    }
    if (params.item.type === "webSearch") {
      // Warm resumes retain raw-event delivery, while cold resumes expose no
      // capability bit. Wait through the drain; finalization closes misses unknown.
      this.webSearchCompletionByItem.set(params.item.id, {
        runWasAborted: this.options.runAbortSignal?.aborted === true,
        sourceTimestampMs: params.sourceTimestampMs,
      });
      return;
    }

    const itemDurationMs =
      typeof params.item.durationMs === "number" ? params.item.durationMs : undefined;
    this.recordTerminal(params.item.id, toolName, auditNativeToolTerminalStatus(params.item), {
      itemDurationMs,
      sourceTimestampMs: params.sourceTimestampMs,
    });
  }

  recordApprovalFailureDisposition(
    toolCallId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
  ): void {
    if (!this.completedItemIds.has(toolCallId)) {
      this.approvalFailureDispositionByItem.set(toolCallId, disposition);
    }
  }

  recordPreToolUseFailure(
    failure: CodexNativePreToolUseFailure,
    runWasAborted = this.options.runAbortSignal?.aborted === true,
  ): void {
    if (this.completedItemIds.has(failure.toolCallId)) {
      return;
    }
    const record: CodexNativePreToolUseFailureRecord = {
      failure,
      terminalReason:
        runWasAborted && this.options.runAbortSignal
          ? resolveCodexToolAbortTerminalReason(this.options.runAbortSignal)
          : failure.disposition,
    };
    if (this.finalized) {
      // Relay subprocesses can settle after result construction. Emit the
      // item-less fallback here because no later notification drain remains.
      this.completedItemIds.add(failure.toolCallId);
      this.emitPreToolUseFailure(record, failure.toolName, failure.durationMs);
      return;
    }
    this.preToolUseFailureByItem.set(failure.toolCallId, record);
  }

  private recordRawWebSearchResult(item: JsonObject): void {
    if (readString(item, "type") !== "web_search_call") {
      return;
    }
    const toolCallId = readString(item, "id");
    if (!toolCallId || this.completedItemIds.has(toolCallId)) {
      return;
    }
    const toolName = "web_search";
    this.recordStarted(toolCallId, toolName, "unknown");
    const rawStatus = readString(item, "status");
    if (rawStatus === "in_progress" || rawStatus === "running") {
      return;
    }
    const status: CodexNativeToolAuditStatus =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "cancelled"
          ? "cancelled"
          : rawStatus === "failed" || rawStatus === "error" || rawStatus === "incomplete"
            ? "failed"
            : "unknown";
    this.recordTerminal(toolCallId, toolName, status, {
      sourceTimestampMs: this.webSearchCompletionByItem.get(toolCallId)?.sourceTimestampMs,
    });
  }

  private recordTerminal(
    toolCallId: string,
    toolName: string,
    status: CodexNativeToolAuditStatus,
    options: {
      itemDurationMs?: number;
      sourceTimestampMs?: number;
      runWasAborted?: boolean;
    } = {},
  ): void {
    const runWasAborted = options.runWasAborted ?? this.options.runAbortSignal?.aborted === true;
    const preToolUseFailure = this.preToolUseFailureByItem.get(toolCallId);
    this.preToolUseFailureByItem.delete(toolCallId);
    const approvalFailureDisposition = this.approvalFailureDispositionByItem.get(toolCallId);
    this.approvalFailureDispositionByItem.delete(toolCallId);
    this.completedItemIds.add(toolCallId);
    this.activeItems.delete(toolCallId);
    this.webSearchCompletionByItem.delete(toolCallId);
    const startedAt = this.startedAtByItem.get(toolCallId);
    this.startedAtByItem.delete(toolCallId);
    const endedAt = options.sourceTimestampMs ?? Date.now();
    const durationMs =
      options.itemDurationMs ?? (startedAt === undefined ? 0 : Math.max(0, endedAt - startedAt));
    if (preToolUseFailure) {
      this.emitPreToolUseFailure(
        preToolUseFailure,
        toolName,
        durationMs,
        options.sourceTimestampMs,
      );
      return;
    }
    const terminalEvent = approvalFailureDisposition
      ? {
          type: "tool.execution.error" as const,
          durationMs,
          errorCategory: "codex_native_tool_approval",
          terminalReason: approvalFailureDisposition,
        }
      : status === "blocked"
        ? {
            type: "tool.execution.blocked" as const,
            reason: "codex_native_tool_blocked",
            deniedReason: "codex_native_tool_blocked",
          }
        : status === "failed" || status === "cancelled" || status === "unknown"
          ? {
              type: "tool.execution.error" as const,
              durationMs,
              errorCategory:
                status === "unknown"
                  ? "codex_native_tool_outcome_unknown"
                  : status === "cancelled"
                    ? "aborted"
                    : "codex_native_tool_error",
              ...(status === "unknown" ? { errorCode: "tool_outcome_unknown" } : {}),
              terminalReason:
                // An enclosing abort explains unfinished work, but cannot classify
                // a native terminal whose status is absent or unrecognized.
                status === "unknown"
                  ? ("failed" as const)
                  : runWasAborted && this.options.runAbortSignal
                    ? resolveCodexToolAbortTerminalReason(this.options.runAbortSignal)
                    : status === "cancelled"
                      ? ("cancelled" as const)
                      : ("failed" as const),
            }
          : {
              type: "tool.execution.completed" as const,
              durationMs,
            };
    emitTrustedDiagnosticEvent({
      ...this.buildBase(toolCallId, toolName),
      ...terminalEvent,
      ...(options.sourceTimestampMs !== undefined
        ? { sourceTimestampMs: options.sourceTimestampMs }
        : {}),
    });
  }

  finalizeActive(runWasAborted = this.options.runAbortSignal?.aborted === true): void {
    this.finalized = true;
    for (const [toolCallId, { toolName, unfinishedStatus }] of this.activeItems) {
      const webSearchCompletion = this.webSearchCompletionByItem.get(toolCallId);
      const itemRunWasAborted = webSearchCompletion
        ? webSearchCompletion.runWasAborted
        : runWasAborted;
      this.recordTerminal(toolCallId, toolName, unfinishedStatus, {
        runWasAborted: itemRunWasAborted,
        sourceTimestampMs: webSearchCompletion?.sourceTimestampMs,
      });
    }
    for (const [toolCallId, record] of this.preToolUseFailureByItem) {
      if (!this.completedItemIds.has(toolCallId)) {
        this.recordTerminal(toolCallId, record.failure.toolName, "failed", {
          itemDurationMs: record.failure.durationMs,
        });
      }
    }
    this.activeItems.clear();
    this.webSearchCompletionByItem.clear();
    this.approvalFailureDispositionByItem.clear();
    this.preToolUseFailureByItem.clear();
  }

  private emitPreToolUseFailure(
    record: CodexNativePreToolUseFailureRecord,
    toolName: string,
    durationMs: number,
    sourceTimestampMs?: number,
  ): void {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: this.context.agentId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      runId: this.context.runId,
      failure: { ...record.failure, toolName, durationMs },
      terminalReason: record.terminalReason,
      sourceTimestampMs,
    });
  }

  private recordSnapshotItem(item: CodexThreadItem): void {
    if (
      !auditNativeToolName(item) ||
      this.completedItemIds.has(item.id) ||
      itemStatus(item) === "running"
    ) {
      return;
    }
    const toolName = auditNativeToolName(item);
    if (!toolName) {
      return;
    }
    this.recordStarted(item.id, toolName, auditNativeToolUnfinishedStatus(item));
    this.recordItem({ phase: "result", item });
  }

  private recordStarted(
    toolCallId: string,
    toolName: string,
    unfinishedStatus: CodexNativeToolUnfinishedStatus,
    sourceTimestampMs?: number,
  ): void {
    if (this.activeItems.has(toolCallId)) {
      return;
    }
    this.startedAtByItem.set(toolCallId, sourceTimestampMs ?? Date.now());
    this.activeItems.set(toolCallId, { toolName, unfinishedStatus });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...this.buildBase(toolCallId, toolName),
      ...(sourceTimestampMs !== undefined ? { sourceTimestampMs } : {}),
    });
  }

  private buildBase(toolCallId: string, toolName: string) {
    return {
      agentId: this.context.agentId,
      runId: this.context.runId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      toolName,
      toolCallId,
    };
  }
}

type ReasoningDeltaMethod = "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta";

type ReasoningTextGroup = {
  itemId: string;
  method: ReasoningDeltaMethod;
  index: number;
  text: string;
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

const MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM = 20;
const TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS = 10_000;
const TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS = 1_024;
// FIFO holds genuinely distinct emitted shapes (summary/chunk/final/aggregate). Stream
// accumulation owns a dedicated slot and does not consume FIFO capacity.
const TOOL_PROGRESS_ECHO_SIGNATURE_CAP = MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM + 4;
const TOOL_OUTPUT_TRUNCATION_NOTICE_PREFIX = "...(OpenClaw truncated Codex native tool output";
const MISSING_TOOL_RESULT_ERROR =
  "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.";
const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";
const BYTES_PER_MB = 1024 * 1024;
// Match OpenClaw's default image media cap for generated image tool outputs.
const DEFAULT_GENERATED_IMAGE_MAX_BYTES = 6 * BYTES_PER_MB;
const TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES = new Set([
  "message",
  "messages",
  "reply",
  "send",
  "reaction",
  "react",
  "typing",
]);

export function shouldEmitTranscriptToolProgress(toolName: unknown, _args?: unknown): boolean {
  const normalized = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  return Boolean(normalized && !TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES.has(normalized));
}

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

type ToolProgressRawSignature = {
  length: number;
  prefix: string;
};

type ToolProgressEchoState = {
  displayTexts: string[];
  // Single slot for handleOutputDelta accumulation; replaced per delta (not appended).
  streamedDisplayText?: string;
  // One logical stream shape; replaced per delta (not pushed into rawSignatures FIFO).
  streamedRawSignature?: ToolProgressRawSignature;
  rawSignatures: ToolProgressRawSignature[];
};

type ToolOutputTrimState = {
  totalLength: number;
  leadingWhitespaceLength: number;
  trailingWhitespaceLength: number;
  sawNonWhitespace: boolean;
};

export class CodexAppServerEventProjector {
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantItemOrder: string[] = [];
  private readonly assistantPhaseByItem = new Map<string, string>();
  private latestCompletedItemId: string | undefined;
  private latestCompletedTerminalAssistantItemId: string | undefined;
  private latestTerminalAssistantCandidateItemId: string | undefined;
  private latestTerminalAssistantCandidateSuperseded = false;
  private latestTerminalAssistantCandidateCanReleaseAfterToolHandoff = false;
  private terminalAssistantCandidateEarlierActiveItemIds = new Set<string>();
  private pendingRawTerminalAssistantEchoItemId: string | undefined;
  private readonly lastCommentaryProgressTextByItem = new Map<string, string>();
  // Codex emits each typed item completion before its matching raw response item.
  // Pair by protocol order because contributors may rewrite only the typed text.
  private pendingRawCommentaryEchoes = 0;
  private readonly reasoningTextByGroup = new Map<string, ReasoningTextGroup>();
  private readonly reasoningItemOrder = new Map<string, number>();
  private readonly planTextByItem = new Map<string, string>();
  private readonly activeItemIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private readonly activeCompactionItemIds = new Set<string>();
  private readonly toolProgressEchoesByItem = new Map<string, ToolProgressEchoState>();
  // Raw lane re-emissions are the echo channel; typed agentMessage completions are deliberate
  // finals (codex-rs userShell injects as user-role, never assistant). Filtering typed items
  // would drop legitimate verbatim answers ("reply with exactly the command output").
  private readonly rawPromotedAssistantItemIds = new Set<string>();
  private readonly toolResultSummaryItemIds = new Set<string>();
  private readonly toolResultOutputItemIds = new Set<string>();
  private readonly toolResultOutputStreamedItemIds = new Set<string>();
  private readonly transcriptToolProgressSuppressedIds = new Set<string>();
  private readonly toolTranscriptArgumentsById = new Map<string, unknown>();
  private readonly toolResultOutputDeltaState = new Map<
    string,
    { chars: number; messages: number; truncated: boolean }
  >();
  private readonly toolResultOutputPrefixByItem = new Map<string, string>();
  private readonly toolResultOutputTextByItem = new Map<string, string>();
  private readonly toolResultOutputTextOriginalLengthByItem = new Map<string, number>();
  private readonly toolResultOutputTextNormalizedLengthByItem = new Map<string, number>();
  private readonly toolResultOutputTextTrimStateByItem = new Map<string, ToolOutputTrimState>();
  // Once an output delta crosses the transcript cap, later deltas must not fill
  // UTF-16 capacity recovered by backing up over a split surrogate pair.
  private readonly toolResultOutputTextTruncatedItemIds = new Set<string>();
  private readonly toolMetas = new Map<string, EmbeddedRunAttemptResult["toolMetas"][number]>();
  private readonly terminalPresentationClearedItemIds = new Set<string>();
  private readonly nativeToolOutcomeOrdinals = new Map<string, number>();
  private readonly sideEffectingToolItemIds = new Set<string>();
  private readonly sideEffectingDynamicToolCallIds = new Set<string>();
  private readonly toolTranscriptMessages: AgentMessage[] = [];
  private readonly toolTranscriptCallIds = new Set<string>();
  private readonly toolTranscriptResultIds = new Set<string>();
  private readonly toolTranscriptNamesById = new Map<string, string>();
  private readonly toolTrajectoryCallIds = new Set<string>();
  private readonly toolTrajectoryResultIds = new Set<string>();
  private readonly toolTrajectoryNamesById = new Map<string, string>();
  private readonly toolTrajectoryItemsById = new Map<string, CodexThreadItem>();
  private readonly transcriptToolProgressCallIds = new Set<string>();
  private lastNativeToolError: EmbeddedRunAttemptResult["lastToolError"];
  private readonly nativeGeneratedMediaItemIds = new Set<string>();
  private readonly nativeGeneratedMediaUrlsByItemId = new Map<string, string>();
  private readonly nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector;
  private readonly afterToolCallObservedItemIds = new Set<string>();
  private assistantStarted = false;
  private reasoningStarted = false;
  private reasoningEnded = false;
  private streamedPartialAssistantItemId: string | undefined;
  private streamedPartialAssistantItemReplaceable = false;
  private completedTurn: CodexTurn | undefined;
  private promptError: unknown;
  private promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
  private synthesizedMissingToolResultError: string | null = null;
  private aborted = false;
  private tokenUsage: ReturnType<typeof normalizeUsage>;
  private guardianReviewCount = 0;
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
  }

  getCompletedTurnStatus(): CodexTurn["status"] | undefined {
    return this.completedTurn?.status;
  }

  hasCompletedTerminalAssistantText(): boolean {
    const latestCompletedItemId = this.latestCompletedTerminalAssistantItemId;
    if (!latestCompletedItemId) {
      return false;
    }
    const finalItem = this.resolveFinalAssistantTextItem();
    return (
      this.latestCompletedItemId === latestCompletedItemId &&
      finalItem?.itemId === latestCompletedItemId &&
      this.completedItemIds.has(latestCompletedItemId)
    );
  }

  getLatestTerminalAssistantCandidate(): { itemId: string; hasText: boolean } | undefined {
    const itemId = this.latestTerminalAssistantCandidateItemId;
    if (!itemId) {
      return undefined;
    }
    const text = this.assistantTextByItem.get(itemId)?.trim();
    return {
      itemId,
      hasText: Boolean(text && !this.isToolProgressEchoText(itemId, text)),
    };
  }

  hasLatestTerminalAssistantCandidateText(): boolean {
    return (
      !this.latestTerminalAssistantCandidateSuperseded &&
      this.getLatestTerminalAssistantCandidate()?.hasText === true
    );
  }

  canReleaseLatestTerminalAssistantAfterToolHandoff(): boolean {
    return (
      this.latestTerminalAssistantCandidateCanReleaseAfterToolHandoff &&
      this.hasLatestTerminalAssistantCandidateText()
    );
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
        await this.handleAssistantDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.handleReasoningDelta(notification.method, params);
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
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        this.handleGuardianReviewNotification(notification.method, params);
        break;
      case "guardianWarning":
        this.handleGuardianWarning(params);
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
    const assistantTexts = this.collectAssistantTexts();
    const reasoningText = collectReasoningTextValues(
      this.reasoningTextByGroup,
      this.reasoningItemOrder,
    ).join("\n\n");
    const planText = collectTextValues(this.planTextByItem).join("\n\n");
    const hasAssistantItemText = this.hasAssistantItemTextForSynthesis();
    const legacyFailClosed =
      !this.completedTurn || this.completedTurn.status !== "completed" || hasAssistantItemText;
    const hasDeliverableAssistantOnCompletedTurn =
      this.completedTurn?.status === "completed" &&
      assistantTexts.some((text) => text.trim().length > 0);
    this.synthesizeMissingToolResults({
      synthesize: legacyFailClosed,
      recordPromptError: legacyFailClosed && !hasDeliverableAssistantOnCompletedTurn,
    });
    const lastAssistant =
      assistantTexts.length > 0
        ? this.createAssistantMessage(assistantTexts.join("\n\n"))
        : undefined;
    const currentAttemptAssistant = this.createCurrentAttemptAssistantMessage();
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
    const messagesSnapshot: AgentMessage[] = this.params.suppressNextUserMessagePersistence
      ? []
      : [attachCodexMirrorIdentity(buildCodexUserPromptMessage(this.params), `${turnId}:prompt`)];
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
    const toolMetas = [...this.toolMetas.values()];
    const hadPotentialSideEffects =
      toolTelemetry.didSendViaMessagingTool ||
      (toolTelemetry.successfulCronAdds ?? 0) > 0 ||
      this.nativeGeneratedMediaItemIds.size > 0 ||
      this.sideEffectingToolItemIds.size > 0 ||
      this.sideEffectingDynamicToolCallIds.size > 0;
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
      ...(this.lastNativeToolError ? { lastToolError: this.lastNativeToolError } : {}),
      didSendViaMessagingTool: toolTelemetry.didSendViaMessagingTool,
      didDeliverSourceReplyViaMessageTool:
        toolTelemetry.didDeliverSourceReplyViaMessageTool === true,
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
      didSendDeterministicApprovalPrompt: this.guardianReviewCount > 0 ? false : undefined,
    };
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    const args = sanitizeCodexToolArguments(params.arguments);
    this.recordToolTranscriptCall({
      id: params.callId,
      name: params.tool,
      arguments: args,
    });
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
    const resultText = collectDynamicToolContentText(params.contentItems);
    const existing = this.toolMetas.get(params.callId);
    this.toolMetas.set(params.callId, {
      toolName: existing?.toolName ?? params.tool,
      ...(existing?.meta ? { meta: existing.meta } : {}),
      ...(params.asyncStarted === true ? { asyncStarted: true } : {}),
      ...(!params.success ? { isError: true } : {}),
    });
    this.recordToolTranscriptResult({
      id: params.callId,
      name: params.tool,
      text: resultText,
      isError: !params.success,
    });
    if (!params.success && params.terminalType === "blocked") {
      this.lastNativeToolError = {
        toolName: params.tool,
        error: resultText || "codex dynamic tool blocked",
      };
    } else if (
      params.success &&
      this.lastNativeToolError &&
      !this.lastNativeToolError.mutatingAction
    ) {
      this.lastNativeToolError = undefined;
    }
    if (params.sideEffectEvidence === true) {
      this.sideEffectingDynamicToolCallIds.add(params.callId);
    }
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
    const itemId = readString(params, "itemId") ?? "assistant";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    if (itemId !== this.pendingRawTerminalAssistantEchoItemId) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    // Deltas carry no phase; the item/started notification for this item has
    // already recorded it in assistantPhaseByItem.
    const isCommentary = this.isCommentaryAssistantItem(itemId);
    if (!isCommentary && itemId !== this.latestTerminalAssistantCandidateItemId) {
      this.markTerminalAssistantCandidateSupersededBy();
    }
    if (!this.assistantStarted) {
      this.assistantStarted = true;
      await this.params.onAssistantMessageStart?.();
    }
    this.rememberAssistantItem(itemId);
    const text = `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`;
    this.assistantTextByItem.set(itemId, text);
    if (isCommentary) {
      this.emitCommentaryProgress({ itemId, text });
    } else {
      const knownFinalAnswer = this.shouldStreamAssistantPartial(itemId);
      const replace =
        this.streamedPartialAssistantItemId !== undefined &&
        this.streamedPartialAssistantItemId !== itemId;
      // Codex defines final_answer as terminal text. Replacement mode is for
      // phase-unknown/provisional items; append-only consumers cannot retract
      // bytes after a known terminal answer has started.
      if (replace && (!knownFinalAnswer || this.streamedPartialAssistantItemReplaceable)) {
        this.streamedPartialAssistantItemReplaceable = true;
      } else if (this.streamedPartialAssistantItemId === undefined) {
        this.streamedPartialAssistantItemReplaceable = !knownFinalAnswer;
      }
      this.streamedPartialAssistantItemId = itemId;
      const replaceable = this.streamedPartialAssistantItemReplaceable;
      const replacement = replace && replaceable;
      const streamPayload = {
        text,
        delta: replacement ? "" : delta,
        ...(replacement ? { replace: true as const } : {}),
      };
      this.emitAgentEvent({
        stream: "assistant",
        data: {
          ...streamPayload,
          ...(replaceable ? { replaceable: true as const } : {}),
        },
      });
      // Legacy channel preview callbacks are append-oriented and do not all
      // understand replacement snapshots. Keep them on the known final-answer
      // path; replaceable snapshots stay on the typed agent-event path.
      if (knownFinalAnswer && !replaceable) {
        await this.params.onPartialReply?.(streamPayload);
      }
    }
    // Stream non-commentary assistant deltas as partial replies and assistant
    // agent events so live surfaces (TUI, WebChat) render incremental answer
    // text via gateway emitChatDelta. When Codex switches to a new non-commentary
    // item, mark replace:true with an empty delta so live merge and append-oriented
    // partial consumers reset to the new cumulative text instead of concatenating.
  }

  private async handleReasoningDelta(
    method: ReasoningDeltaMethod,
    params: JsonObject,
  ): Promise<void> {
    const itemId = readString(params, "itemId") ?? "reasoning";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.reasoningStarted = true;
    if (!this.reasoningItemOrder.has(itemId)) {
      this.reasoningItemOrder.set(itemId, this.reasoningItemOrder.size);
    }
    // Codex indexes reasoning sections independently within an item. Keep those
    // sections separate so the live snapshot matches the completed item shape.
    const groupIndex =
      method === "item/reasoning/textDelta"
        ? (readNonNegativeInteger(params, "contentIndex") ?? 0)
        : (readNonNegativeInteger(params, "summaryIndex") ?? 0);
    const groupKey = `${method}\0${itemId}\0${groupIndex}`;
    const current = this.reasoningTextByGroup.get(groupKey);
    this.reasoningTextByGroup.set(groupKey, {
      itemId,
      method,
      index: groupIndex,
      text: `${current?.text ?? ""}${delta}`,
    });
    await this.params.onReasoningStream?.({
      text: collectReasoningTextValues(this.reasoningTextByGroup, this.reasoningItemOrder).join(
        "\n\n",
      ),
      isReasoningSnapshot: true,
    });
  }

  private handlePlanDelta(params: JsonObject): void {
    const itemId = readString(params, "itemId") ?? "plan";
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
    const itemId = item?.id ?? readString(params, "itemId");
    if (
      item?.type === "agentMessage" &&
      itemId &&
      itemId !== this.pendingRawTerminalAssistantEchoItemId
    ) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    this.rememberAssistantPhase(item);
    if (itemId) {
      this.activeItemIds.add(itemId);
      if (itemId !== this.latestTerminalAssistantCandidateItemId) {
        this.markTerminalAssistantCandidateSupersededBy(itemId, {
          preserveEarlierActiveItem: true,
        });
        if (this.latestTerminalAssistantCandidateSuperseded) {
          this.pendingRawTerminalAssistantEchoItemId = undefined;
        }
      }
    }
    this.recordNativeToolOutcome(item);
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
    this.recordToolMeta(item);
    this.emitStandardItemEvent({ phase: "start", item });
    await this.emitNormalizedToolItemEvent({ phase: "start", item });
    this.recordNativeToolTranscriptCall(item);
    this.emitToolResultSummary(item);
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
    if (
      item?.type === "agentMessage" &&
      itemId &&
      itemId !== this.pendingRawTerminalAssistantEchoItemId
    ) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
      this.latestCompletedItemId = itemId;
    }
    this.rememberAssistantPhase(item);
    if (item?.type === "agentMessage" && !this.isCommentaryAssistantItem(item.id)) {
      this.latestCompletedTerminalAssistantItemId = item.id;
      this.markLatestTerminalAssistantCandidate(item.id);
      this.pendingRawTerminalAssistantEchoItemId = item.id;
    } else if (itemId) {
      this.markTerminalAssistantCandidateSupersededBy(itemId, {
        preserveEarlierActiveItem: true,
      });
      if (this.latestTerminalAssistantCandidateSuperseded) {
        this.pendingRawTerminalAssistantEchoItemId = undefined;
      }
    }
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      this.rememberAssistantItem(item.id);
      this.assistantTextByItem.set(item.id, item.text);
      if (item.text && this.isCommentaryAssistantItem(item.id)) {
        this.emitCommentaryProgress({ itemId: item.id, text: item.text });
        this.pendingRawCommentaryEchoes += 1;
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
      this.options.onContextCompacted?.();
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
    this.rememberCommandAggregateOutputEcho(item);
    this.emitStandardItemEvent({ phase: "end", item });
    await this.emitNormalizedToolItemEvent({ phase: "result", item });
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

  private handleGuardianWarning(params: JsonObject): void {
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        phase: "warning",
        message: readString(params, "message"),
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
    const turn = readCodexTurn(params.turn);
    if (!turn || turn.id !== this.turnId) {
      return;
    }
    this.completedTurn = turn;
    if (turn.status === "failed") {
      this.promptError =
        formatCodexUsageLimitErrorMessage({
          message: turn.error?.message,
          codexErrorInfo: turn.error?.codexErrorInfo as JsonValue | null | undefined,
          rateLimits: this.options.readRecentRateLimits?.(),
        }) ??
        turn.error?.message ??
        "codex app-server turn failed";
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
      this.rememberAssistantPhase(item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        this.rememberAssistantItem(item.id);
        this.assistantTextByItem.set(item.id, item.text);
      }
      this.recordNativeGeneratedMedia(item);
      if (item.type === "plan" && typeof item.text === "string" && item.text) {
        this.planTextByItem.set(item.id, item.text);
        this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(item.text) });
      }
      this.recordToolMeta(item);
      this.rememberCommandAggregateOutputEcho(item);
      await this.emitSnapshotOnlyNativeToolProgress(item);
      this.recordNativeToolTranscriptCall(item);
      this.recordNativeToolTranscriptResult(item);
      this.emitAfterToolCallObservation(item);
      this.emitToolResultSummary(item);
      this.emitToolResultOutput(item);
    }
    this.activeCompactionItemIds.clear();
    await this.maybeEndReasoning();
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
      this.emitStandardItemEvent({ phase: "start", item });
      await this.emitNormalizedToolItemEvent({ phase: "start", item });
    }
    this.activeItemIds.delete(item.id);
    this.emitStandardItemEvent({ phase: "end", item });
    await this.emitNormalizedToolItemEvent({ phase: "result", item });
    this.completedItemIds.add(item.id);
  }

  private isCurrentTurnSnapshotItem(item: CodexThreadItem): boolean {
    const itemTurnId = readItemString(item, "turnId");
    return itemTurnId === undefined || itemTurnId === this.turnId;
  }

  private handleOutputDelta(params: JsonObject, toolName: string): void {
    const itemId = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (!itemId || !delta) {
      return;
    }
    const storedOutput = appendToolOutputDeltaText(
      this.toolResultOutputTextByItem,
      this.toolResultOutputPrefixByItem,
      this.toolResultOutputTextOriginalLengthByItem,
      this.toolResultOutputTextNormalizedLengthByItem,
      this.toolResultOutputTextTrimStateByItem,
      this.toolResultOutputTextTruncatedItemIds,
      itemId,
      delta,
    );
    this.rememberToolProgressEcho(itemId, {
      displayText: storedOutput.text,
      rawLength: storedOutput.normalizedLength,
      rawPrefix: storedOutput.rawPrefix,
      streamedDisplay: true,
    });
    if (!this.shouldEmitToolOutput()) {
      return;
    }
    if (
      this.transcriptToolProgressSuppressedIds.has(itemId) ||
      !shouldEmitTranscriptToolProgress(toolName, this.toolTranscriptArgumentsById.get(itemId))
    ) {
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

  private async handleRawResponseItemCompleted(params: JsonObject): Promise<void> {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item) {
      return;
    }
    const role = readString(item, "role");
    const phase = readString(item, "phase");
    const rawItemId = readString(item, "id");
    const candidateWasSupersededBeforeRaw = this.latestTerminalAssistantCandidateSuperseded;
    const pendingTerminalAssistantEchoItemId = this.pendingRawTerminalAssistantEchoItemId;
    const isPendingTerminalAssistantEcho =
      role === "assistant" &&
      phase !== "commentary" &&
      pendingTerminalAssistantEchoItemId !== undefined &&
      (rawItemId === undefined || rawItemId === pendingTerminalAssistantEchoItemId);
    if (pendingTerminalAssistantEchoItemId !== undefined && !isPendingTerminalAssistantEcho) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    if (!isPendingTerminalAssistantEcho) {
      this.latestCompletedItemId = undefined;
      this.markTerminalAssistantCandidateSupersededBy(rawItemId);
    }
    await this.recordRawGeneratedImageMedia(item);
    if (role !== "assistant") {
      return;
    }
    if (phase === "commentary" && this.pendingRawCommentaryEchoes > 0) {
      this.pendingRawCommentaryEchoes -= 1;
      return;
    }
    const text = extractRawAssistantText(item);
    if (isPendingTerminalAssistantEcho) {
      const typedItemId = pendingTerminalAssistantEchoItemId;
      this.pendingRawTerminalAssistantEchoItemId = undefined;
      // Contributors may rewrite the typed completion without rewriting its raw echo.
      if (this.assistantTextByItem.get(typedItemId)?.trim() || !text) {
        return;
      }
      this.rememberAssistantItem(typedItemId);
      this.assistantTextByItem.set(typedItemId, text);
      return;
    }
    if (!text) {
      return;
    }
    const itemId = rawItemId ?? `raw-assistant-${this.assistantItemOrder.length + 1}`;
    const isIdlessTerminalAssistantAfterCompletedWork =
      candidateWasSupersededBeforeRaw &&
      rawItemId === undefined &&
      pendingTerminalAssistantEchoItemId === undefined &&
      this.activeItemIds.size === 0;
    if (
      phase !== "commentary" &&
      candidateWasSupersededBeforeRaw &&
      itemId !== this.streamedPartialAssistantItemId &&
      !isIdlessTerminalAssistantAfterCompletedWork
    ) {
      return;
    }
    if (phase) {
      this.assistantPhaseByItem.set(itemId, phase);
    }
    this.rememberAssistantItem(itemId);
    this.assistantTextByItem.set(itemId, text);
    this.rawPromotedAssistantItemIds.add(itemId);
    if (phase === "commentary") {
      this.emitCommentaryProgress({ itemId, text });
    } else {
      this.markLatestTerminalAssistantCandidate(itemId, {
        canReleaseAfterToolHandoff: isIdlessTerminalAssistantAfterCompletedWork,
      });
    }
  }

  private markLatestTerminalAssistantCandidate(
    itemId: string,
    options?: { canReleaseAfterToolHandoff?: boolean },
  ): void {
    this.latestTerminalAssistantCandidateItemId = itemId;
    this.latestTerminalAssistantCandidateSuperseded = false;
    this.latestTerminalAssistantCandidateCanReleaseAfterToolHandoff =
      options?.canReleaseAfterToolHandoff === true;
    this.terminalAssistantCandidateEarlierActiveItemIds = new Set(this.activeItemIds);
  }

  private markTerminalAssistantCandidateSupersededBy(
    itemId?: string,
    options?: { preserveEarlierActiveItem?: boolean },
  ): void {
    if (!this.latestTerminalAssistantCandidateItemId) {
      return;
    }
    // Preserve app-server ordering where an item already active at assistant
    // completion reports its delayed completion afterward. Only new work proves
    // the candidate stale; origin/main has an integration test for this order.
    if (itemId && this.terminalAssistantCandidateEarlierActiveItemIds.has(itemId)) {
      if (!options?.preserveEarlierActiveItem) {
        this.terminalAssistantCandidateEarlierActiveItemIds.delete(itemId);
      }
      return;
    }
    this.latestTerminalAssistantCandidateSuperseded = true;
    this.latestTerminalAssistantCandidateCanReleaseAfterToolHandoff = false;
    this.terminalAssistantCandidateEarlierActiveItemIds.clear();
  }

  private recordNativeGeneratedMedia(item: CodexThreadItem | undefined): void {
    if (item?.type !== "imageGeneration") {
      return;
    }
    const savedPath = readItemString(item, "savedPath")?.trim();
    if (savedPath) {
      this.recordNativeGeneratedMediaUrl({
        itemId: item.id,
        mediaUrl: savedPath,
      });
    }
  }

  private async recordRawGeneratedImageMedia(item: JsonObject): Promise<void> {
    if (readString(item, "type") !== "image_generation_call") {
      return;
    }
    const result = readString(item, "result");
    if (!result) {
      return;
    }
    const itemId = readString(item, "id") ?? `raw-image-${this.nativeGeneratedMediaItemIds.size}`;
    this.nativeGeneratedMediaItemIds.add(itemId);
    const maxBytes = resolveGeneratedImageMaxBytes(this.params.config);
    const estimatedDecodedBytes = estimateBase64DecodedBytes(result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn("codex app-server raw image generation result exceeds media limit", {
        itemId,
        estimatedDecodedBytes,
        maxBytes,
      });
      return;
    }
    const asset = generatedImageAssetFromBase64({
      base64: result,
      index: this.nativeGeneratedMediaItemIds.size,
      revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
      fileNamePrefix: "codex-image-generation",
      sniffMimeType: true,
    });
    if (!asset) {
      return;
    }
    try {
      const saved = await saveMediaBuffer(
        asset.buffer,
        asset.mimeType,
        GENERATED_IMAGE_MEDIA_SUBDIR,
        maxBytes,
        asset.fileName,
      );
      this.recordNativeGeneratedMediaUrl({
        itemId,
        mediaUrl: saved.path,
        // The typed savedPath may belong to a remote app-server host. Always
        // prefer the copy persisted into this gateway's managed media root.
        replaceExisting: true,
      });
    } catch (error) {
      embeddedAgentLog.warn("codex app-server raw image generation result save failed", {
        itemId,
        error,
      });
    }
  }

  private recordNativeGeneratedMediaUrl(params: {
    itemId: string;
    mediaUrl: string;
    replaceExisting?: boolean;
  }): void {
    if (
      this.nativeGeneratedMediaUrlsByItemId.has(params.itemId) &&
      params.replaceExisting !== true
    ) {
      this.nativeGeneratedMediaItemIds.add(params.itemId);
      return;
    }
    this.nativeGeneratedMediaUrlsByItemId.set(params.itemId, params.mediaUrl);
    this.nativeGeneratedMediaItemIds.add(params.itemId);
  }

  private buildToolMediaUrls(toolTelemetry: CodexAppServerToolTelemetry): string[] | undefined {
    const mediaUrls = new Set(
      toolTelemetry.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? [],
    );
    if ((toolTelemetry.messagingToolSentMediaUrls?.length ?? 0) === 0) {
      for (const mediaUrl of this.nativeGeneratedMediaUrlsByItemId.values()) {
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

  private shouldStreamAssistantPartial(itemId: string): boolean {
    return this.assistantPhaseByItem.get(itemId) === "final_answer";
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

  private async emitNormalizedToolItemEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem | undefined;
  }): Promise<void> {
    const { item } = params;
    if (!item || !shouldSynthesizeToolProgressForItem(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    const status = params.phase === "result" ? itemStatus(item) : "running";
    const args = itemToolArgs(item);
    const meta = itemMeta(item, this.toolProgressDetailMode());
    this.recordToolTrajectoryEvent({ phase: params.phase, item, name, args, status });
    if (params.phase === "result") {
      this.recordNativeToolError({ item, name, meta, status });
    }
    if (!shouldEmitTranscriptToolProgress(name, args)) {
      if (params.phase === "result") {
        this.emitAfterToolCallObservation(item);
        await this.options.onNativeToolResultRecorded?.();
      }
      return;
    }
    this.emitAgentEvent({
      stream: "tool",
      data: {
        phase: params.phase,
        name,
        itemId: item.id,
        toolCallId: item.id,
        ...(meta ? { meta } : {}),
        ...(params.phase === "start" && args ? { args } : {}),
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
      await this.options.onNativeToolResultRecorded?.();
    }
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

  private recordNativeToolError(params: {
    item: CodexThreadItem;
    name: string;
    meta?: string;
    status: ReturnType<typeof itemStatus>;
  }): void {
    if (!isNonSuccessItemStatus(params.status)) {
      if (!this.lastNativeToolError) {
        return;
      }
      if (!this.lastNativeToolError.mutatingAction) {
        this.lastNativeToolError = undefined;
        return;
      }
      const actionFingerprint = nativeToolActionFingerprint(params.item);
      if (
        this.lastNativeToolError.actionFingerprint &&
        actionFingerprint &&
        this.lastNativeToolError.actionFingerprint === actionFingerprint
      ) {
        this.lastNativeToolError = undefined;
      }
      return;
    }
    const error = itemToolError(params.item, params.status, this.toolResultOutputTextByItem);
    const actionFingerprint = nativeToolActionFingerprint(params.item);
    this.lastNativeToolError = {
      toolName: params.name,
      ...(params.meta ? { meta: params.meta } : {}),
      ...(error ? { error } : {}),
      ...(isMutatingNativeToolItem(params.item) ? { mutatingAction: true } : {}),
      ...(actionFingerprint ? { actionFingerprint } : {}),
    };
  }

  private recordToolTrajectoryEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    name: string;
    args?: Record<string, unknown>;
    status: ReturnType<typeof itemStatus>;
  }): void {
    if (params.phase === "start") {
      this.toolTrajectoryCallIds.add(params.item.id);
      this.toolTrajectoryNamesById.set(params.item.id, params.name);
      this.toolTrajectoryItemsById.set(params.item.id, params.item);
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
    this.toolTrajectoryResultIds.add(params.item.id);
    const toolResult = itemToolResult(params.item).result;
    const output = itemOutputText(params.item, this.toolResultOutputTextByItem);
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
    const error = itemToolError(item, status, this.toolResultOutputTextByItem);
    const startedAt = resolveStartedAtFromDurationMs(item.durationMs);
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
    if (!shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) {
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
    const output = itemOutputText(item, this.toolResultOutputTextByItem);
    if (!toolName || !output) {
      return;
    }
    if (!shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) {
      return;
    }
    this.emitToolResultMessage({
      itemId,
      text: formatToolOutput(toolName, itemMeta(item, this.toolProgressDetailMode()), output),
      finalOutput: true,
      isError: isNonSuccessItemStatus(itemStatus(item)),
    });
  }

  private emitToolResultMessage(params: {
    itemId: string;
    text: string;
    finalOutput?: boolean;
    isError?: boolean;
  }): void {
    const rawText = params.text.trim();
    const text = truncateToolTranscriptText(rawText);
    if (!text) {
      return;
    }
    this.rememberToolProgressEcho(params.itemId, { displayText: text, rawText });
    if (params.finalOutput) {
      this.toolResultOutputItemIds.add(params.itemId);
    }
    try {
      void Promise.resolve(
        this.params.onToolResult?.({
          text,
          ...(params.isError === true ? { isError: true } : {}),
        }),
      ).catch(() => {
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
    if (isSideEffectingNativeToolItem(item)) {
      this.sideEffectingToolItemIds.add(item.id);
    } else {
      this.sideEffectingToolItemIds.delete(item.id);
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    const status = itemStatus(item);
    const existing = this.toolMetas.get(item.id);
    this.toolMetas.set(item.id, {
      toolName,
      ...(meta ? { meta } : {}),
      ...(existing?.asyncStarted ? { asyncStarted: true } : {}),
      ...(status !== "running" && isNonSuccessItemStatus(status) ? { isError: true } : {}),
    });
  }

  private recordNativeToolTranscriptCall(item: CodexThreadItem | undefined): void {
    if (!item || !shouldRecordNativeToolTranscript(item)) {
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
    if (!item || !shouldRecordNativeToolTranscript(item)) {
      return;
    }
    const name = itemName(item);
    if (!name) {
      return;
    }
    this.recordToolTranscriptResult({
      id: item.id,
      name,
      text: itemTranscriptResultText(item, this.toolResultOutputTextByItem),
      isError: isNonSuccessItemStatus(itemStatus(item)),
    });
  }

  private recordToolTranscriptCall(params: ToolTranscriptCallInput): void {
    if (!params.id || !params.name || this.toolTranscriptCallIds.has(params.id)) {
      return;
    }
    this.toolTranscriptCallIds.add(params.id);
    this.toolTranscriptNamesById.set(params.id, params.name);
    this.toolTranscriptArgumentsById.set(params.id, params.arguments);
    if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) {
      this.transcriptToolProgressSuppressedIds.add(params.id);
    } else {
      this.transcriptToolProgressSuppressedIds.delete(params.id);
    }
    this.emitTranscriptToolCallProgress(params);
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
    this.emitTranscriptToolResultProgress(params);
    this.toolTranscriptMessages.push(
      attachCodexMirrorIdentity(
        this.createToolResultMessage(params),
        `${this.turnId}:tool:${params.id}:result`,
      ),
    );
  }

  private synthesizeMissingToolResults(params: {
    synthesize: boolean;
    recordPromptError: boolean;
  }): void {
    if (!params.synthesize) {
      return;
    }
    const missingTranscriptIds = [...this.toolTranscriptCallIds].filter(
      (id) => !this.toolTranscriptResultIds.has(id),
    );
    const missingTrajectoryIds = [...this.toolTrajectoryCallIds].filter(
      (id) => !this.toolTrajectoryResultIds.has(id),
    );
    if (missingTranscriptIds.length === 0 && missingTrajectoryIds.length === 0) {
      return;
    }

    for (const id of missingTranscriptIds) {
      const name = this.toolTranscriptNamesById.get(id) ?? this.toolTrajectoryNamesById.get(id);
      if (!name) {
        continue;
      }
      this.recordToolTranscriptResult({
        id,
        name,
        text: formatMissingToolResultError({ id, name }),
        isError: true,
      });
    }

    for (const id of missingTrajectoryIds) {
      const name = this.toolTrajectoryNamesById.get(id) ?? this.toolTranscriptNamesById.get(id);
      if (!name) {
        continue;
      }
      this.toolTrajectoryResultIds.add(id);
      const text = formatMissingToolResultError({ id, name });
      this.options.trajectoryRecorder?.recordEvent("tool.result", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: id,
        toolCallId: id,
        name,
        status: "failed",
        isError: true,
        result: { status: "failed", reason: "missing_tool_result" },
        output: text,
      });
    }

    if (!params.recordPromptError) {
      const firstMissingId =
        missingTranscriptIds.find((id) => {
          const name = this.toolTranscriptNamesById.get(id) ?? this.toolTrajectoryNamesById.get(id);
          return Boolean(name);
        }) ??
        missingTrajectoryIds.find((id) => {
          const name = this.toolTrajectoryNamesById.get(id) ?? this.toolTranscriptNamesById.get(id);
          return Boolean(name);
        });
      if (firstMissingId) {
        const name =
          this.toolTranscriptNamesById.get(firstMissingId) ??
          this.toolTrajectoryNamesById.get(firstMissingId);
        if (name) {
          const item = this.toolTrajectoryItemsById.get(firstMissingId);
          const meta = item
            ? itemMeta(item, this.toolProgressDetailMode())
            : this.toolMetas.get(firstMissingId)?.meta;
          const actionFingerprint = item ? nativeToolActionFingerprint(item) : undefined;
          this.lastNativeToolError = {
            toolName: name,
            ...(meta ? { meta } : {}),
            error: formatMissingToolResultError({ id: firstMissingId, name }),
            ...(item && isMutatingNativeToolItem(item) ? { mutatingAction: true } : {}),
            ...(actionFingerprint ? { actionFingerprint } : {}),
          };
        }
      }
      return;
    }
    const missingCount = new Set([...missingTranscriptIds, ...missingTrajectoryIds]).size;
    this.synthesizedMissingToolResultError =
      missingCount === 1
        ? MISSING_TOOL_RESULT_ERROR
        : `${MISSING_TOOL_RESULT_ERROR} missingToolResultCount=${missingCount}`;
    this.promptErrorSource = this.promptErrorSource ?? "prompt";
  }

  private emitTranscriptToolCallProgress(params: ToolTranscriptCallInput): void {
    if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) {
      return;
    }
    this.transcriptToolProgressCallIds.add(params.id);
    const args = normalizeToolTranscriptArguments(params.arguments);
    const meta = inferToolMetaFromArgs(params.name, args, {
      detailMode: this.toolProgressDetailMode(),
    });
    if (
      !this.params.onToolResult ||
      !this.shouldEmitToolResult() ||
      this.toolResultSummaryItemIds.has(params.id) ||
      this.toolResultOutputStreamedItemIds.has(params.id)
    ) {
      return;
    }
    this.toolResultSummaryItemIds.add(params.id);
    this.emitToolResultMessage({
      itemId: params.id,
      text: formatToolSummary(params.name, meta),
    });
  }

  private emitTranscriptToolResultProgress(params: ToolTranscriptResultInput): void {
    if (
      this.transcriptToolProgressSuppressedIds.has(params.id) ||
      !shouldEmitTranscriptToolProgress(
        params.name,
        this.toolTranscriptArgumentsById.get(params.id),
      )
    ) {
      return;
    }
    if (!this.transcriptToolProgressCallIds.has(params.id)) {
      this.emitTranscriptToolCallProgress({
        id: params.id,
        name: params.name,
        arguments: {},
      });
    }
    if (
      !this.params.onToolResult ||
      !this.shouldEmitToolOutput() ||
      this.toolResultOutputItemIds.has(params.id) ||
      this.toolResultOutputStreamedItemIds.has(params.id)
    ) {
      return;
    }
    const text = params.text?.trim();
    if (!text) {
      return;
    }
    this.emitToolResultMessage({
      itemId: params.id,
      text: formatToolOutput(params.name, undefined, text),
      finalOutput: true,
      isError: params.isError,
    });
  }

  private formatCodexErrorMessage(params: JsonObject): string | undefined {
    const error = isJsonObject(params.error) ? params.error : undefined;
    return (
      formatCodexUsageLimitErrorMessage({
        message: error ? readString(error, "message") : undefined,
        codexErrorInfo: error?.codexErrorInfo,
        rateLimits: this.options.readRecentRateLimits?.(),
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

  private hasAssistantItemTextForSynthesis(): boolean {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId) {
        continue;
      }
      if (this.assistantPhaseByItem.get(itemId) === "commentary") {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId);
      if (text && text.length > 0) {
        return true;
      }
    }
    return false;
  }

  private resolveFinalAssistantText(): string | undefined {
    return this.resolveFinalAssistantTextItem()?.text;
  }

  private resolveFinalAssistantTextItem(): { itemId: string; text: string } | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (this.assistantPhaseByItem.get(itemId) === "commentary") {
        continue;
      }
      if (text && !this.isToolProgressEchoText(itemId, text)) {
        return { itemId, text };
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

  private createCurrentAttemptAssistantMessage(): AssistantMessage | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (
        !itemId ||
        this.isCommentaryAssistantItem(itemId) ||
        !this.assistantTextByItem.has(itemId)
      ) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId) ?? "";
      const normalizedText = text.trim();
      if (normalizedText && this.isToolProgressEchoText(itemId, normalizedText)) {
        continue;
      }
      return this.createAssistantMessage(text);
    }
    return undefined;
  }

  private isToolProgressEchoText(itemId: string, text: string): boolean {
    if (!this.rawPromotedAssistantItemIds.has(itemId)) {
      return false;
    }
    for (const state of this.toolProgressEchoesByItem.values()) {
      if (state.streamedDisplayText === text) {
        return true;
      }
      if (state.displayTexts.includes(text)) {
        return true;
      }
      if (
        state.streamedRawSignature &&
        text.length === state.streamedRawSignature.length &&
        text.startsWith(state.streamedRawSignature.prefix)
      ) {
        return true;
      }
      for (const signature of state.rawSignatures) {
        if (text.length === signature.length && text.startsWith(signature.prefix)) {
          return true;
        }
      }
    }
    return false;
  }

  private rememberToolProgressEcho(
    itemId: string,
    signature: {
      displayText?: string;
      rawText?: string;
      rawLength?: number;
      rawPrefix?: string;
      streamedDisplay?: boolean;
    },
  ): void {
    if (!itemId) {
      return;
    }
    const existing = this.toolProgressEchoesByItem.get(itemId) ?? {
      displayTexts: [],
      rawSignatures: [],
    };
    const displayText = signature.displayText?.trim();
    if (displayText) {
      if (signature.streamedDisplay) {
        existing.streamedDisplayText = displayText;
      } else if (!existing.displayTexts.includes(displayText)) {
        if (existing.displayTexts.length >= TOOL_PROGRESS_ECHO_SIGNATURE_CAP) {
          existing.displayTexts.shift();
        }
        existing.displayTexts.push(displayText);
      }
    }
    const rawText = signature.rawText?.trim();
    const rawLength = signature.rawLength ?? rawText?.length;
    const rawPrefix = signature.rawPrefix?.trim() ?? rawText;
    if (
      rawLength !== undefined &&
      rawPrefix &&
      rawPrefix.length >= TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS
    ) {
      const next: ToolProgressRawSignature = {
        length: rawLength,
        prefix: rawPrefix.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS),
      };
      if (signature.streamedDisplay) {
        // Stream accumulation is one logical shape; replace the dedicated slot only.
        existing.streamedRawSignature = next;
      } else {
        const matchIndex = existing.rawSignatures.findIndex(
          (entry) => entry.prefix === next.prefix,
        );
        if (matchIndex >= 0) {
          existing.rawSignatures[matchIndex] = next;
        } else {
          if (existing.rawSignatures.length >= TOOL_PROGRESS_ECHO_SIGNATURE_CAP) {
            existing.rawSignatures.shift();
          }
          existing.rawSignatures.push(next);
        }
      }
    }
    this.toolProgressEchoesByItem.set(itemId, existing);
  }

  private rememberCommandAggregateOutputEcho(item: CodexThreadItem | undefined): void {
    if (item?.type !== "commandExecution" || typeof item.aggregatedOutput !== "string") {
      return;
    }
    const signature = toolOutputRawEchoSignature(item.aggregatedOutput);
    if (!signature) {
      return;
    }
    this.rememberToolProgressEcho(item.id, signature);
  }

  private async readMirroredSessionMessages(): Promise<AgentMessage[]> {
    return (
      (await readCodexMirroredSessionHistoryMessages({
        agentId: this.params.agentId,
        sessionFile: this.params.sessionFile,
        sessionId: this.params.sessionId,
        sessionKey: this.params.sessionKey,
      })) ?? []
    );
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
      api: attribution.api ?? "openai-chatgpt-responses",
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
      api: attribution.api ?? "openai-chatgpt-responses",
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
      api: attribution.api ?? "openai-chatgpt-responses",
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

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function estimateBase64DecodedBytes(base64: string): number | undefined {
  let nonWhitespaceLength = 0;
  let previousCode = -1;
  let lastCode = -1;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (isBase64WhitespaceCode(code)) {
      continue;
    }
    nonWhitespaceLength += 1;
    previousCode = lastCode;
    lastCode = code;
  }
  if (nonWhitespaceLength === 0) {
    return undefined;
  }
  const equalsCode = "=".charCodeAt(0);
  const padding = lastCode === equalsCode ? (previousCode === equalsCode ? 2 : 1) : 0;
  return Math.max(0, Math.floor((nonWhitespaceLength * 3) / 4) - padding);
}

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function resolveGeneratedImageMaxBytes(config: EmbeddedRunAttemptParams["config"]): number {
  const configured = config?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * BYTES_PER_MB);
  }
  return DEFAULT_GENERATED_IMAGE_MAX_BYTES;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

function readNonEmptyString(record: JsonObject, key: string): string | undefined {
  return normalizeNonEmptyString(record[key]);
}

function readNonEmptyStringArray(record: JsonObject, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of value) {
    const normalized = normalizeNonEmptyString(entry);
    if (normalized) {
      entries.push(normalized);
    }
  }
  return entries;
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

function resolveStartedAtFromDurationMs(durationMs: unknown): number | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return undefined;
  }
  return asDateTimestampMs(Date.now() - Math.max(0, durationMs));
}

function readNonNegativeInteger(record: JsonObject, key: string): number | undefined {
  const value = readNumber(record, key);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readCodexErrorNotificationMessage(record: JsonObject): string | undefined {
  const error = record.error;
  return isJsonObject(error) ? readString(error, "message") : undefined;
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

function normalizeCodexTokenUsage(record: JsonObject): ReturnType<typeof normalizeUsage> {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input and cache reads separately.
  const inputTokens = readNumber(record, "inputTokens");
  const cacheRead = readNumber(record, "cachedInputTokens");
  const input =
    inputTokens !== undefined && cacheRead !== undefined
      ? Math.max(0, inputTokens - cacheRead)
      : inputTokens;
  return normalizeUsage({
    input,
    output: readNumber(record, "outputTokens"),
    cacheRead,
    total: readNumber(record, "totalTokens"),
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

function collectReasoningTextValues(
  groups: Map<string, ReasoningTextGroup>,
  itemOrder: Map<string, number>,
): string[] {
  return [...groups.values()]
    .toSorted((left, right) => {
      const itemDelta =
        (itemOrder.get(left.itemId) ?? Number.MAX_SAFE_INTEGER) -
        (itemOrder.get(right.itemId) ?? Number.MAX_SAFE_INTEGER);
      if (itemDelta !== 0) {
        return itemDelta;
      }
      const methodDelta = reasoningMethodOrder(left.method) - reasoningMethodOrder(right.method);
      return methodDelta !== 0 ? methodDelta : left.index - right.index;
    })
    .map((group) => group.text)
    .filter((text) => text.trim().length > 0);
}

function reasoningMethodOrder(method: ReasoningDeltaMethod): number {
  return method === "item/reasoning/summaryTextDelta" ? 0 : 1;
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
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "declined") {
    return "blocked";
  }
  if (status === "inProgress" || status === "in_progress" || status === "running") {
    return "running";
  }
  return "completed";
}

function auditNativeToolTerminalStatus(item: CodexThreadItem): CodexNativeToolAuditStatus {
  if (item.type === "imageView" || item.type === "sleep") {
    return "completed";
  }
  const status = readItemString(item, "status");
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "declined") {
    return "blocked";
  }
  // A completed notification with a missing, active, or new status does not
  // prove success. Preserve that ambiguity at the durable audit boundary.
  return "unknown";
}

function auditNativeToolUnfinishedStatus(item: CodexThreadItem): CodexNativeToolUnfinishedStatus {
  // Search and image generation publish explicit terminal states. An enclosing
  // run outcome cannot substitute when that dependency-owned state is absent.
  return item.type === "webSearch" || item.type === "imageGeneration" ? "unknown" : "failed";
}

function formatMissingToolResultError(params: { id: string; name: string }): string {
  return `${MISSING_TOOL_RESULT_ERROR} toolCallId=${params.id}; toolName=${params.name}`;
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

function auditNativeToolName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall") {
    return undefined;
  }
  const progressName = itemName(item);
  if (progressName) {
    return progressName;
  }
  if (item.type === "collabAgentToolCall") {
    return typeof item.tool === "string" && item.tool.trim()
      ? `collab.${item.tool.trim()}`
      : "collab_agent";
  }
  if (item.type === "imageGeneration") {
    return "image_generation";
  }
  if (item.type === "imageView") {
    return "image_view";
  }
  if (item.type === "sleep") {
    return "sleep";
  }
  return undefined;
}

function isSideEffectingNativeToolItem(item: CodexThreadItem): boolean {
  return (
    itemStatus(item) !== "blocked" &&
    (isMutatingNativeToolItem(item) || item.type === "mcpToolCall")
  );
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

function shouldRecordNativeToolTranscript(item: CodexThreadItem): boolean {
  return shouldSynthesizeToolProgressForItem(item) && item.type !== "webSearch";
}

function isMutatingNativeToolItem(item: CodexThreadItem): boolean {
  if (item.type === "commandExecution") {
    // Codex commandActions describe presentation, not safety. Upstream may
    // classify mutating commands as read/search, so native commands fail closed.
    return true;
  }
  return (
    item.type === "fileChange" ||
    item.type === "collabAgentToolCall" ||
    item.type === "imageGeneration"
  );
}

function shouldClearTerminalPresentationForNativeItem(item: CodexThreadItem): boolean {
  switch (item.type) {
    case "collabAgentToolCall":
    case "commandExecution":
    case "fileChange":
    case "imageGeneration":
    case "imageView":
    case "mcpToolCall":
    case "webSearch":
      return true;
    default:
      return false;
  }
}

function nativeToolActionFingerprint(item: CodexThreadItem): string | undefined {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return JSON.stringify({
      type: item.type,
      command: item.command,
      cwd: typeof item.cwd === "string" ? item.cwd : "",
    });
  }
  if (item.type === "fileChange") {
    return JSON.stringify({
      type: item.type,
      changes: itemFileChanges(item),
    });
  }
  return undefined;
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
      changes: itemFileChangesForTranscript(item),
    });
  }
  if (item.type === "webSearch") {
    return webSearchToolArgs(item);
  }
  if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") {
    return sanitizeCodexToolArguments(item.arguments);
  }
  return undefined;
}

function webSearchToolArgs(item: CodexThreadItem): Record<string, unknown> {
  const action = isJsonObject(item.action) ? item.action : undefined;
  const actionType = action ? readNonEmptyString(action, "type") : undefined;
  const queries =
    action && actionType === "search" ? readNonEmptyStringArray(action, "queries") : [];
  const query =
    normalizeNonEmptyString(item.query) ??
    (action && actionType === "search" ? readNonEmptyString(action, "query") : undefined) ??
    queries[0];
  const url = action ? readNonEmptyString(action, "url") : undefined;
  const pattern = action ? readNonEmptyString(action, "pattern") : undefined;
  const args: Record<string, unknown> = {};
  if (query) {
    args.query = query;
  }
  if (queries.length > 0) {
    args.queries = queries;
  }
  if (actionType && actionType !== "search") {
    args.action = actionType;
  }
  if (url) {
    args.url = url;
  }
  if (pattern) {
    args.pattern = pattern;
  }
  if (!query && !url && !pattern) {
    args.queryUnavailable = true;
  }
  return sanitizeCodexAgentEventRecord(args);
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
    return { result: webSearchToolResult(item) };
  }
  return {};
}

function webSearchToolResult(item: CodexThreadItem): Record<string, unknown> {
  return sanitizeCodexAgentEventRecord({
    status: itemStatus(item),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...webSearchToolArgs(item),
  });
}

type CodexFileChangeSummary = {
  path: string;
  kind: unknown;
};

type CodexTranscriptFileChange = CodexFileChangeSummary & {
  diff?: string;
  diffTruncated?: true;
  stat?: { added: number; removed: number };
};

function itemFileChangeRecords(item: CodexThreadItem): JsonObject[] {
  const changes = (item as Record<string, unknown>).changes;
  return Array.isArray(changes) ? changes.filter(isJsonObject) : [];
}

function itemFileChanges(item: CodexThreadItem): CodexFileChangeSummary[] {
  return itemFileChangeRecords(item).flatMap((change) => {
    const path = normalizeNonEmptyString(change.path);
    if (!path || change.kind === undefined) {
      return [];
    }
    return [{ path, kind: change.kind }];
  });
}

function fileChangeKindType(kind: unknown): string | undefined {
  if (typeof kind === "string") {
    return kind;
  }
  return isJsonObject(kind) ? normalizeNonEmptyString(kind.type) : undefined;
}

function countFileContentLines(content: string): number {
  if (!content) {
    return 0;
  }
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

function fileChangeDiffStat(diff: string, kind: unknown): { added: number; removed: number } {
  const kindType = fileChangeKindType(kind);
  if (kindType === "add") {
    return { added: countFileContentLines(diff), removed: 0 };
  }
  if (kindType === "delete") {
    return { added: 0, removed: countFileContentLines(diff) };
  }
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function truncateFileChangeDiffAtLineBoundary(
  diff: string,
  maxChars: number,
): { diff?: string; diffTruncated?: true } {
  if (diff.length <= maxChars) {
    return { diff };
  }
  if (maxChars <= 0) {
    return { diffTruncated: true };
  }
  const boundary = diff.lastIndexOf("\n", maxChars - 1);
  return boundary >= 0
    ? { diff: diff.slice(0, boundary + 1), diffTruncated: true }
    : { diffTruncated: true };
}

function itemFileChangesForTranscript(item: CodexThreadItem): CodexTranscriptFileChange[] {
  let remainingDiffChars = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS;
  return itemFileChangeRecords(item).flatMap((change) => {
    const path = normalizeNonEmptyString(change.path);
    if (!path || change.kind === undefined) {
      return [];
    }
    const result: CodexTranscriptFileChange = { path, kind: change.kind };
    if (typeof change.diff !== "string") {
      return [result];
    }
    result.stat = fileChangeDiffStat(change.diff, change.kind);
    const bounded = truncateFileChangeDiffAtLineBoundary(change.diff, remainingDiffChars);
    if (bounded.diff !== undefined) {
      result.diff = bounded.diff;
      remainingDiffChars -= bounded.diff.length;
    }
    if (bounded.diffTruncated) {
      result.diffTruncated = true;
    }
    return [result];
  });
}

function itemToolError(
  item: CodexThreadItem,
  status: ReturnType<typeof itemStatus>,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  if (status === "blocked") {
    return "codex native tool blocked";
  }
  if (status !== "failed") {
    return undefined;
  }
  return itemOutputText(item, outputTextByItem) ?? "codex native tool failed";
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
  if (item.type === "webSearch") {
    return inferToolMetaFromArgs("web_search", webSearchToolArgs(item), { detailMode });
  }
  const toolName = itemName(item);
  if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && toolName) {
    return inferToolMetaFromArgs(toolName, item.arguments, { detailMode });
  }
  return undefined;
}

function itemOutputText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput?.trim() || outputTextByItem?.get(item.id)?.trim();
    return output ? truncateToolTranscriptText(output) : undefined;
  }
  if (item.type === "dynamicToolCall") {
    const output = collectDynamicToolContentText(item.contentItems).trim();
    return output ? truncateToolTranscriptText(output) : undefined;
  }
  if (item.type === "mcpToolCall") {
    const output = item.error
      ? stringifyJsonValue(item.error)
      : item.result
        ? stringifyJsonValue(item.result)
        : undefined;
    return output ? truncateToolTranscriptText(output) : undefined;
  }
  return undefined;
}

function itemTranscriptResultText(
  item: CodexThreadItem,
  outputTextByItem?: ReadonlyMap<string, string>,
): string | undefined {
  const output = itemOutputText(item, outputTextByItem);
  if (output) {
    return output;
  }
  const result = itemToolResult(item).result;
  const resultText = result ? stringifyJsonValue(result) : undefined;
  return resultText ? truncateToolTranscriptText(resultText) : itemStatus(item);
}

function appendToolOutputDeltaText(
  outputTextByItem: Map<string, string>,
  outputPrefixByItem: Map<string, string>,
  originalLengthByItem: Map<string, number>,
  normalizedLengthByItem: Map<string, number>,
  trimStateByItem: Map<string, ToolOutputTrimState>,
  truncatedItemIds: Set<string>,
  itemId: string,
  delta: string,
): { text: string; originalLength: number; normalizedLength: number; rawPrefix: string } {
  const previousOriginalLength =
    originalLengthByItem.get(itemId) ?? outputTextByItem.get(itemId)?.length ?? 0;
  const originalLength = previousOriginalLength + delta.length;
  originalLengthByItem.set(itemId, originalLength);
  const normalizedLength = updateToolOutputTrimState(trimStateByItem, itemId, delta);
  normalizedLengthByItem.set(itemId, normalizedLength);
  // Lengths keep growing after truncation for echo matching + the notice total;
  // the stored raw prefix freezes so later deltas cannot fill UTF-16 capacity
  // recovered by backing up over a split surrogate pair (see class field comment).
  if (truncatedItemIds.has(itemId)) {
    const frozenPrefix = outputPrefixByItem.get(itemId) ?? outputTextByItem.get(itemId) ?? "";
    const next = appendBoundedToolTranscriptText(frozenPrefix, "", originalLength);
    outputPrefixByItem.set(itemId, next.rawPrefix);
    outputTextByItem.set(itemId, next.text);
    return { text: next.text, originalLength, normalizedLength, rawPrefix: next.rawPrefix };
  }
  const currentPrefix = outputPrefixByItem.get(itemId) ?? outputTextByItem.get(itemId) ?? "";
  const next = appendBoundedToolTranscriptText(currentPrefix, delta, originalLength);
  outputPrefixByItem.set(itemId, next.rawPrefix);
  outputTextByItem.set(itemId, next.text);
  if (originalLength > TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    truncatedItemIds.add(itemId);
  }
  return { text: next.text, originalLength, normalizedLength, rawPrefix: next.rawPrefix };
}

function updateToolOutputTrimState(
  trimStateByItem: Map<string, ToolOutputTrimState>,
  itemId: string,
  delta: string,
): number {
  const state = trimStateByItem.get(itemId) ?? {
    totalLength: 0,
    leadingWhitespaceLength: 0,
    trailingWhitespaceLength: 0,
    sawNonWhitespace: false,
  };
  state.totalLength += delta.length;
  const firstNonWhitespace = delta.search(/\S/u);
  if (firstNonWhitespace === -1) {
    if (!state.sawNonWhitespace) {
      state.leadingWhitespaceLength += delta.length;
    }
    state.trailingWhitespaceLength += delta.length;
    trimStateByItem.set(itemId, state);
    return state.sawNonWhitespace
      ? state.totalLength - state.leadingWhitespaceLength - state.trailingWhitespaceLength
      : 0;
  }
  if (!state.sawNonWhitespace) {
    state.leadingWhitespaceLength += firstNonWhitespace;
    state.sawNonWhitespace = true;
  }
  state.trailingWhitespaceLength = delta.match(/\s*$/u)?.[0].length ?? 0;
  trimStateByItem.set(itemId, state);
  return state.totalLength - state.leadingWhitespaceLength - state.trailingWhitespaceLength;
}

function toolOutputRawEchoSignature(
  text: string,
): { rawLength: number; rawPrefix: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    rawLength: trimmed.length,
    rawPrefix: trimmed.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS),
  };
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

function appendBoundedToolTranscriptText(
  currentPrefix: string,
  delta: string,
  originalLength: number,
): { text: string; rawPrefix: string } {
  if (originalLength <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    const rawPrefix = currentPrefix + delta;
    return { text: rawPrefix, rawPrefix };
  }
  const notice = toolTranscriptTruncationNotice(originalLength);
  if (notice.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return { text: notice.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS), rawPrefix: "" };
  }
  const textBudget = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - notice.length;
  const remaining = Math.max(0, textBudget - currentPrefix.length);
  const prefix =
    remaining > 0 ? `${currentPrefix}${truncateUtf16Safe(delta, remaining)}` : currentPrefix;
  const rawPrefix = truncateUtf16Safe(prefix, textBudget);
  return { text: `${rawPrefix}${notice}`, rawPrefix };
}

function toolTranscriptTruncationNotice(originalLength: number): string {
  const noticeText = `${TOOL_OUTPUT_TRUNCATION_NOTICE_PREFIX}: original ${originalLength} chars, showing ${TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS}; rerun with narrower args.)`;
  return `\n${noticeText}`;
}

function truncateToolTranscriptText(text: string, originalLength = text.length): string {
  if (
    originalLength <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS &&
    text.length <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS
  ) {
    return text;
  }
  const notice = toolTranscriptTruncationNotice(originalLength);
  if (notice.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) {
    return notice.slice(1, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS + 1);
  }
  const textBudget = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - notice.length;
  return `${truncateUtf16Safe(text, textBudget)}${notice}`;
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
