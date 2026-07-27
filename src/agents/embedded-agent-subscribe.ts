/**
 * Subscribes to embedded-agent sessions and streams formatted replies/events.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { InlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import {
  buildCodeSpanIndex,
  createInlineCodeState,
} from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { emitAgentEvent, emitAgentEventIfCurrent } from "../infra/agent-events.js";
import { recordAgentRunOutputTokens } from "../infra/agent-run-usage.js";
import type { AssistantMessage } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { findFinalTagMatches } from "../shared/text/final-tags.js";
import { hasOrphanReasoningCloseBoundary } from "../shared/text/reasoning-tags.js";
import { parseInlineDirectives } from "../utils/directive-tags.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./embedded-agent-runner/delivery-evidence.js";
import {
  createEmbeddedRunReplayState,
  mergeEmbeddedRunReplayState,
} from "./embedded-agent-runner/replay-state.js";
import { consumeEmbeddedToolSendReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import type { EmbeddedRunLivenessState } from "./embedded-agent-runner/types.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { createEmbeddedAgentSessionEventHandler } from "./embedded-agent-subscribe.handlers.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.js";
import {
  cleanupRunToolStartData,
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";
import {
  buildToolLifecycleErrorResult,
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-subscribe.tools.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { stripDowngradedToolCallText, THINKING_TAG_SCAN_RE } from "./embedded-agent-utils.js";
import { mediaUrlsFromGeneratedAttachments } from "./generated-attachments.js";
import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";
import type { AgentMessage } from "./runtime/index.js";
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "./usage.js";

const STREAM_STRIPPED_BLOCK_TAG_NAMES = [
  "final",
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "mm:think",
  "mm:thinking",
  "mm:thought",
] as const;
const embeddedLog = createSubsystemLogger("agent/embedded");

function resolveEmbeddedAgentSessionLogger(messageChannel?: string) {
  const normalizedChannel = normalizeMessageChannel(messageChannel);
  if (normalizedChannel && isDeliverableMessageChannel(normalizedChannel)) {
    return createSubsystemLogger(`gateway/channels/${normalizedChannel}`);
  }
  return embeddedLog;
}

function isPotentialTrailingBlockTagFragment(fragment: string): boolean {
  if (!fragment.startsWith("<") || fragment.includes(">")) {
    return false;
  }
  const body = fragment.toLowerCase().slice(1).trimStart().replace(/^\//, "").trimStart();
  if (!body) {
    return true;
  }
  const namePart = body.split(/[\s/>]/, 1)[0] ?? "";
  if (!namePart) {
    return true;
  }
  return STREAM_STRIPPED_BLOCK_TAG_NAMES.some((name) => {
    return name.startsWith(namePart) || namePart === name;
  });
}

function splitTrailingBlockTagFragment(
  text: string,
  isInsideCodeSpan: (index: number) => boolean,
): { text: string; pendingTagFragment?: string } {
  const fragmentStart = text.lastIndexOf("<");
  if (fragmentStart === -1 || isInsideCodeSpan(fragmentStart)) {
    return { text };
  }
  const fragment = text.slice(fragmentStart);
  if (!isPotentialTrailingBlockTagFragment(fragment)) {
    return { text };
  }
  return {
    text: text.slice(0, fragmentStart),
    pendingTagFragment: fragment,
  };
}

function splitTrailingFenceFragment(
  text: string,
  startsAtLineStart: boolean,
): { text: string; pendingFenceFragment?: string } {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if ((!startsAtLineStart && lineStart === 0) || !/^(?: {0,3})(?:`+|~+)$/.test(line)) {
    return { text };
  }
  return {
    text: text.slice(0, lineStart),
    pendingFenceFragment: line,
  };
}

function collectPendingMediaFromInternalEvents(
  events: SubscribeEmbeddedAgentSessionParams["internalEvents"],
): string[] {
  if (!events?.length) {
    return [];
  }
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const mediaUrls = [
      ...(Array.isArray(event.mediaUrls) ? event.mediaUrls : []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ];
    for (const mediaUrl of mediaUrls) {
      const normalized = normalizeOptionalString(mediaUrl) ?? "";
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      pending.push(normalized);
    }
  }
  return pending;
}

export function subscribeEmbeddedAgentSession(params: SubscribeEmbeddedAgentSessionParams) {
  const log = resolveEmbeddedAgentSessionLogger(params.messageChannel);
  const reasoningMode = params.reasoningMode ?? "off";
  const canShowReasoning = params.thinkingLevel !== "off";
  const toolResultFormat = params.toolResultFormat ?? "markdown";
  const useMarkdown = toolResultFormat === "markdown";
  const initialPendingToolMediaUrls = collectPendingMediaFromInternalEvents(params.internalEvents);
  const state: EmbeddedAgentSubscribeState = {
    assistantTexts: [],
    toolMetas: [],
    acceptedSessionSpawns: [],
    toolMetaById: new Map(),
    toolSummaryById: new Set(),
    itemActiveIds: new Set(),
    itemStartedCount: 0,
    itemCompletedCount: 0,
    lastToolError: undefined,
    blockReplyBreak: params.blockReplyBreak ?? "text_end",
    reasoningMode,
    includeReasoning: reasoningMode === "on" && canShowReasoning,
    shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
    streamReasoning:
      (params.streamReasoningInNonStreamModes === true
        ? reasoningMode !== "on"
        : reasoningMode === "stream") &&
      canShowReasoning &&
      typeof params.onReasoningStream === "function",
    deltaBuffer: "",
    blockBuffer: "",
    // Track if a streamed chunk opened a <think> block (stateful across chunks).
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    partialBlockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    lastStreamedAssistant: undefined,
    lastStreamedAssistantCleaned: undefined,
    emittedAssistantUpdate: false,
    lastStreamedReasoning: undefined,
    lastBlockReplyText: undefined,
    lastDeliveredBlockReplyText: undefined,
    deferBlockReplyDelivery: typeof params.onBeforeTerminalDelivery === "function",
    deferredBlockReplies: [],
    deferredAssistantEvents: [],
    toolExecutionSinceLastBlockReply: false,
    reasoningStreamOpen: false,
    assistantMessageIndex: 0,
    lastAssistantStreamContentIndex: undefined,
    lastAssistantStreamItemId: undefined,
    lastAssistantTextMessageIndex: -1,
    lastAssistantTextNormalized: undefined,
    lastAssistantTextTrimmed: undefined,
    assistantTextBaseline: 0,
    suppressBlockChunks: false, // Avoid late chunk inserts after final text merge.
    lastReasoningSent: undefined,
    pendingAssistantUsage: undefined,
    assistantUsageCommitted: false,
    compactionInFlight: false,
    lastCompactionTokensAfter: undefined,
    pendingCompactionRetry: 0,
    compactionRetryResolve: undefined,
    compactionRetryReject: undefined,
    compactionRetryPromise: null,
    unsubscribed: false,
    replayState: createEmbeddedRunReplayState(params.initialReplayState),
    livenessState: "working",
    hadDeterministicSideEffect: false,
    pendingEventChain: null,
    messagingToolSentTexts: [],
    messagingToolSentTextsNormalized: [],
    messagingToolSentTargets: [],
    heartbeatToolResponse: undefined,
    messagingToolSentMediaUrls: [],
    messagingToolSourceReplyPayloads: [],
    messageToolOnlySourceReplyDelivered: false,
    pendingMessagingTexts: new Map(),
    pendingMessagingTargets: new Map(),
    successfulCronAdds: 0,
    pendingMessagingMediaUrls: new Map(),
    pendingToolMediaUrls: initialPendingToolMediaUrls,
    pendingToolAudioAsVoice: false,
    pendingToolTrustedLocalMedia: false,
    hasToolMediaBlockReply: false,
    visibleBlockReplyCount: 0,
    pendingAssistantReplyDirectives: undefined,
    deterministicApprovalPromptPending: false,
    deterministicApprovalPromptSent: false,
  };
  const usageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
    total: 0,
  };
  let lastAssistantUsage: ReturnType<typeof normalizeUsage>;
  let compactionCount = 0;
  let currentAttemptAssistant: AssistantMessage | undefined;

  const assistantTexts = state.assistantTexts;
  const toolMetas = state.toolMetas;
  const toolMetaById = state.toolMetaById;
  const toolSummaryById = state.toolSummaryById;
  const messagingToolSentTexts = state.messagingToolSentTexts;
  const messagingToolSentTextsNormalized = state.messagingToolSentTextsNormalized;
  const messagingToolSentTargets = state.messagingToolSentTargets;
  const messagingToolSentMediaUrls = state.messagingToolSentMediaUrls;
  const messagingToolSourceReplyPayloads = state.messagingToolSourceReplyPayloads;
  const pendingMessagingTexts = state.pendingMessagingTexts;
  const pendingMessagingTargets = state.pendingMessagingTargets;
  const pendingBlockReplyTasks = new Set<Promise<void>>();
  const replyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  const partialReplyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  const shouldAllowSilentTurnText = (text: string | undefined) =>
    Boolean(text && isSilentReplyText(text, SILENT_REPLY_TOKEN));
  const emitAssistantStreamDataSafely = (
    delivery: EmbeddedAgentSubscribeContext["state"]["deferredAssistantEvents"][number],
  ) => {
    const { data } = delivery;
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data,
    });
    if (params.onAgentEvent) {
      runBestEffortCallback({
        label: "assistant agent event",
        log,
        callback: () =>
          params.onAgentEvent?.({
            stream: "assistant",
            data,
          }),
      });
    }
    if (delivery.emitPartialReply && params.onPartialReply && state.shouldEmitPartialReplies) {
      runBestEffortCallback({
        label: "assistant partial reply",
        log,
        callback: () => params.onPartialReply?.(data),
      });
    }
  };
  const emitAssistantStreamData = (
    data: EmbeddedAgentSubscribeContext["state"]["deferredAssistantEvents"][number]["data"],
    options?: { emitPartialReply?: boolean },
  ) => {
    const delivery = { data, emitPartialReply: options?.emitPartialReply === true };
    if (state.deferBlockReplyDelivery) {
      state.deferredAssistantEvents.push(delivery);
      return;
    }
    emitAssistantStreamDataSafely(delivery);
  };
  const flushDeferredAssistantEvents = () => {
    if (state.deferredAssistantEvents.length === 0) {
      return;
    }
    const deferred = state.deferredAssistantEvents.splice(0);
    for (const delivery of deferred) {
      emitAssistantStreamDataSafely(delivery);
    }
  };
  const clearDeferredAssistantEvents = () => {
    state.deferredAssistantEvents.length = 0;
  };
  const deferredToolMediaReplies = new WeakSet<BlockReplyPayload>();
  const emitBlockReplySafely = (
    payload: Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0],
    options?: { assistantMessageIndex?: number },
  ): boolean => {
    if (!params.onBlockReply) {
      return false;
    }
    try {
      const taggedPayload =
        options?.assistantMessageIndex !== undefined
          ? setReplyPayloadMetadata(payload, {
              assistantMessageIndex: options.assistantMessageIndex,
            })
          : payload;
      const assistantMessageIndex =
        options?.assistantMessageIndex ??
        getReplyPayloadMetadata(taggedPayload)?.assistantMessageIndex;
      const context = assistantMessageIndex === undefined ? undefined : { assistantMessageIndex };
      const maybeTask = context
        ? params.onBlockReply(taggedPayload, context)
        : params.onBlockReply(taggedPayload);
      if (!isPromiseLike<void>(maybeTask)) {
        return true;
      }
      const task = Promise.resolve(maybeTask).catch((err: unknown) => {
        log.warn(`block reply callback failed: ${String(err)}`);
      });
      pendingBlockReplyTasks.add(task);
      void task.finally(() => {
        pendingBlockReplyTasks.delete(task);
      });
      return true;
    } catch (err) {
      log.warn(`block reply callback failed: ${String(err)}`);
      return false;
    }
  };
  const emitBlockReply = (
    payload: BlockReplyPayload,
    options?: { assistantMessageIndex?: number; consumePendingToolMedia?: boolean },
  ) => {
    const withAssistantDirectives = consumePendingAssistantReplyDirectivesIntoReply(state, payload);
    const consumesPendingToolMedia =
      options?.consumePendingToolMedia !== false && readPendingToolMediaReply(state) !== null;
    const withToolMedia =
      options?.consumePendingToolMedia === false
        ? withAssistantDirectives
        : consumePendingToolMediaIntoReply(state, withAssistantDirectives);
    if (state.deferBlockReplyDelivery) {
      const deferredPayload =
        options?.assistantMessageIndex !== undefined
          ? setReplyPayloadMetadata(withToolMedia, {
              assistantMessageIndex: options.assistantMessageIndex,
            })
          : withToolMedia;
      if (consumesPendingToolMedia) {
        deferredToolMediaReplies.add(deferredPayload);
      }
      state.deferredBlockReplies.push(deferredPayload);
      return;
    }
    const emitted = emitBlockReplySafely(withToolMedia, options);
    if (emitted && !withToolMedia.isReasoning && hasAssistantVisibleReply(withToolMedia)) {
      state.visibleBlockReplyCount += 1;
      if (consumesPendingToolMedia) {
        state.hasToolMediaBlockReply = true;
      }
    }
  };
  const flushDeferredBlockReplies = () => {
    if (state.deferredBlockReplies.length === 0) {
      return;
    }
    const deferred = state.deferredBlockReplies.splice(0);
    for (const payload of deferred) {
      const emitted = emitBlockReplySafely(payload);
      if (emitted && !payload.isReasoning && hasAssistantVisibleReply(payload)) {
        state.visibleBlockReplyCount += 1;
        if (deferredToolMediaReplies.has(payload)) {
          state.hasToolMediaBlockReply = true;
        }
      }
    }
  };
  const clearDeferredBlockReplies = () => {
    state.deferredBlockReplies.length = 0;
  };

  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
    state.deltaBuffer = "";
    state.blockBuffer = "";
    blockChunker?.reset();
    replyDirectiveAccumulator.reset();
    partialReplyDirectiveAccumulator.reset();
    state.blockState.thinking = false;
    state.blockState.final = false;
    state.blockState.inlineCode = createInlineCodeState();
    state.blockState.fence = undefined;
    state.blockState.reasoningInlineCode = undefined;
    state.blockState.reasoningFence = undefined;
    state.blockState.reasoningPendingFenceFragment = undefined;
    state.blockState.finalInlineCode = undefined;
    state.blockState.finalFence = undefined;
    state.blockState.pendingFenceFragment = undefined;
    state.blockState.pendingTagFragment = undefined;
    state.partialBlockState.thinking = false;
    state.partialBlockState.final = false;
    state.partialBlockState.inlineCode = createInlineCodeState();
    state.partialBlockState.fence = undefined;
    state.partialBlockState.reasoningInlineCode = undefined;
    state.partialBlockState.reasoningFence = undefined;
    state.partialBlockState.reasoningPendingFenceFragment = undefined;
    state.partialBlockState.finalInlineCode = undefined;
    state.partialBlockState.finalFence = undefined;
    state.partialBlockState.pendingFenceFragment = undefined;
    state.partialBlockState.pendingTagFragment = undefined;
    state.lastStreamedAssistant = undefined;
    state.lastStreamedAssistantCleaned = undefined;
    state.emittedAssistantUpdate = false;
    state.lastBlockReplyText = undefined;
    state.lastStreamedReasoning = undefined;
    state.lastReasoningSent = undefined;
    state.reasoningStreamOpen = false;
    state.suppressBlockChunks = false;
    state.pendingAssistantUsage = undefined;
    state.assistantUsageCommitted = false;
    state.assistantMessageIndex += 1;
    state.lastAssistantStreamContentIndex = undefined;
    state.lastAssistantStreamItemId = undefined;
    state.lastAssistantTextMessageIndex = -1;
    state.lastAssistantTextNormalized = undefined;
    state.lastAssistantTextTrimmed = undefined;
    state.assistantTextBaseline = nextAssistantTextBaseline;
    state.pendingAssistantReplyDirectives = undefined;
  };

  const rememberAssistantText = (text: string) => {
    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string) => {
    if (state.lastAssistantTextMessageIndex !== state.assistantMessageIndex) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
      return true;
    }
    const normalized = normalizeTextForComparison(text);
    if (normalized.length > 0 && normalized === state.lastAssistantTextNormalized) {
      return true;
    }
    return false;
  };

  const pushAssistantText = (text: string) => {
    if (!text) {
      return;
    }
    if (params.silentExpected && !shouldAllowSilentTurnText(text)) {
      return;
    }
    if (shouldSkipAssistantText(text)) {
      return;
    }
    assistantTexts.push(text);
    rememberAssistantText(text);
  };

  const finalizeAssistantTexts = (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered } = args;

    // If we're not streaming block replies, ensure the final payload includes
    // the final text even when interim streaming was enabled.
    if (state.includeReasoning && text && !params.onBlockReply) {
      if (assistantTexts.length > state.assistantTextBaseline) {
        assistantTexts.splice(
          state.assistantTextBaseline,
          assistantTexts.length - state.assistantTextBaseline,
          text,
        );
        rememberAssistantText(text);
      } else {
        pushAssistantText(text);
      }
      state.suppressBlockChunks = true;
    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
      // Non-streaming models (no text_delta): ensure assistantTexts gets the final
      // text when the chunker has nothing buffered to drain.
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  // ── Messaging tool duplicate detection ──────────────────────────────────────
  // Track texts sent via messaging tools to suppress duplicate block replies.
  // Only committed (successful) texts are checked - pending texts are tracked
  // to support commit logic but not used for suppression (avoiding lost messages on tool failure).
  // These tools can send messages via sendMessage/threadReply actions (or sessions_send with message).
  const MAX_MESSAGING_SENT_TEXTS = 200;
  const MAX_MESSAGING_SENT_TARGETS = 200;
  const MAX_MESSAGING_SENT_MEDIA_URLS = 200;
  const MAX_MESSAGING_SOURCE_REPLY_PAYLOADS = 200;
  const trimMessagingToolSent = () => {
    if (messagingToolSentTexts.length > MAX_MESSAGING_SENT_TEXTS) {
      const overflow = messagingToolSentTexts.length - MAX_MESSAGING_SENT_TEXTS;
      messagingToolSentTexts.splice(0, overflow);
      messagingToolSentTextsNormalized.splice(0, overflow);
    }
    if (messagingToolSentTargets.length > MAX_MESSAGING_SENT_TARGETS) {
      const overflow = messagingToolSentTargets.length - MAX_MESSAGING_SENT_TARGETS;
      messagingToolSentTargets.splice(0, overflow);
    }
    if (messagingToolSentMediaUrls.length > MAX_MESSAGING_SENT_MEDIA_URLS) {
      const overflow = messagingToolSentMediaUrls.length - MAX_MESSAGING_SENT_MEDIA_URLS;
      messagingToolSentMediaUrls.splice(0, overflow);
    }
    if (messagingToolSourceReplyPayloads.length > MAX_MESSAGING_SOURCE_REPLY_PAYLOADS) {
      const overflow =
        messagingToolSourceReplyPayloads.length - MAX_MESSAGING_SOURCE_REPLY_PAYLOADS;
      messagingToolSourceReplyPayloads.splice(0, overflow);
    }
  };

  const ensureCompactionPromise = () => {
    if (!state.compactionRetryPromise) {
      // Create a single promise that resolves when ALL pending compactions complete
      // (tracked by pendingCompactionRetry counter, decremented in resolveCompactionRetry)
      state.compactionRetryPromise = new Promise((resolve, reject) => {
        state.compactionRetryResolve = resolve;
        state.compactionRetryReject = reject;
      });
      // Prevent unhandled rejection if rejected after all consumers have resolved
      state.compactionRetryPromise.catch((err: unknown) => {
        log.debug(`compaction promise rejected (no waiter): ${String(err)}`);
      });
    }
  };

  const noteCompactionRetry = () => {
    state.pendingCompactionRetry += 1;
    ensureCompactionPromise();
  };

  const resolveCompactionPromiseIfIdle = () => {
    if (state.pendingCompactionRetry !== 0 || state.compactionInFlight) {
      return;
    }
    state.compactionRetryResolve?.();
    state.compactionRetryResolve = undefined;
    state.compactionRetryReject = undefined;
    state.compactionRetryPromise = null;
  };

  const resolveCompactionRetry = () => {
    if (state.pendingCompactionRetry <= 0) {
      return;
    }
    state.pendingCompactionRetry -= 1;
    resolveCompactionPromiseIfIdle();
  };

  const maybeResolveCompactionWait = () => {
    resolveCompactionPromiseIfIdle();
  };
  const resolveAssistantUsage = (usageLike: unknown) => {
    const candidates: unknown[] = [usageLike];
    if (usageLike && typeof usageLike === "object") {
      const record = usageLike as Record<string, unknown>;
      const partial =
        record.partial && typeof record.partial === "object"
          ? (record.partial as Record<string, unknown>)
          : undefined;
      const message =
        record.message && typeof record.message === "object"
          ? (record.message as Record<string, unknown>)
          : undefined;
      candidates.push(
        record.usage,
        record.timings,
        record.partial,
        record.message,
        partial?.usage,
        partial?.timings,
        message?.usage,
        message?.timings,
      );
    }
    for (const candidate of candidates) {
      const usage = normalizeUsage((candidate ?? undefined) as UsageLike | undefined);
      if (hasNonzeroUsage(usage)) {
        return usage;
      }
    }
    return undefined;
  };
  const emitRunUsage = (outputTokens: number) => {
    const lifecycleGeneration = params.lifecycleGeneration;
    if (!lifecycleGeneration) {
      return;
    }
    const data = recordAgentRunOutputTokens({
      runId: params.runId,
      lifecycleGeneration,
      outputTokens,
      emit: (usage) =>
        emitAgentEventIfCurrent({
          runId: params.runId,
          lifecycleGeneration,
          stream: "usage",
          data: usage,
        }),
    });
    if (!data || !params.onAgentEvent) {
      return;
    }
    runBestEffortCallback({
      label: "usage agent event",
      log,
      callback: () => params.onAgentEvent?.({ stream: "usage", data }),
    });
  };
  const commitAssistantUsage = () => {
    if (state.assistantUsageCommitted || !state.pendingAssistantUsage) {
      return;
    }
    const usage = state.pendingAssistantUsage;
    usageTotals.input += usage.input ?? 0;
    usageTotals.output += usage.output ?? 0;
    usageTotals.cacheRead += usage.cacheRead ?? 0;
    usageTotals.cacheWrite += usage.cacheWrite ?? 0;
    usageTotals.reasoningTokens += usage.reasoningTokens ?? 0;
    const usageTotal =
      usage.total ??
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    usageTotals.total += usageTotal;
    // A terminal abort may report zeros after several completed model calls.
    // Retain the latest committed nonzero call so context accounting stays exact.
    lastAssistantUsage = { ...usage };
    state.assistantUsageCommitted = true;
    emitRunUsage(usage.output ?? 0);
  };
  const recordAssistantUsage = (usageLike: unknown) => {
    if (state.assistantUsageCommitted) {
      return;
    }
    const usage = resolveAssistantUsage(usageLike);
    if (!usage) {
      return;
    }
    state.pendingAssistantUsage = usage;
  };
  const getUsageTotals = () => {
    const hasUsage =
      usageTotals.input > 0 ||
      usageTotals.output > 0 ||
      usageTotals.cacheRead > 0 ||
      usageTotals.cacheWrite > 0 ||
      usageTotals.reasoningTokens > 0 ||
      usageTotals.total > 0;
    if (!hasUsage) {
      return undefined;
    }
    const derivedTotal =
      usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
    return {
      input: usageTotals.input || undefined,
      output: usageTotals.output || undefined,
      cacheRead: usageTotals.cacheRead || undefined,
      cacheWrite: usageTotals.cacheWrite || undefined,
      ...(usageTotals.reasoningTokens > 0 ? { reasoningTokens: usageTotals.reasoningTokens } : {}),
      total: usageTotals.total || derivedTotal || undefined,
    };
  };
  const getLastAssistantUsage = () => (lastAssistantUsage ? { ...lastAssistantUsage } : undefined);
  const incrementCompactionCount = () => {
    compactionCount += 1;
  };
  const noteCompactionTokensAfter = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return;
    }
    state.lastCompactionTokensAfter = Math.floor(value);
  };

  const blockChunking = params.blockReplyChunking;
  const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
  // KNOWN: Provider streams are not strictly once-only or perfectly ordered.
  // `text_end` can repeat full content; late `text_end` can arrive after `message_end`.
  // Tests: `src/agents/embedded-agent-subscribe.test.ts` (e.g. late text_end cases).
  const shouldEmitToolResult = () =>
    typeof params.shouldEmitToolResult === "function"
      ? params.shouldEmitToolResult()
      : params.verboseLevel === "on" || params.verboseLevel === "full";
  const shouldEmitToolOutput = () =>
    typeof params.shouldEmitToolOutput === "function"
      ? params.shouldEmitToolOutput()
      : params.verboseLevel === "full";
  const formatToolOutputBlock = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return "(no output)";
    }
    if (!useMarkdown) {
      return trimmed;
    }
    return `\`\`\`txt\n${trimmed}\n\`\`\``;
  };
  const emitToolResultMessage = (
    toolName: string | undefined,
    message: string,
    result?: unknown,
  ) => {
    if (!params.onToolResult) {
      return;
    }
    const parsed = parseInlineDirectives(message, {
      stripAudioTag: true,
      stripReplyTags: true,
    });
    const mediaArtifact = result ? extractToolResultMediaArtifact(result) : undefined;
    const filteredMediaUrls = filterToolResultMediaUrls(
      toolName,
      mediaArtifact?.mediaUrls ?? [],
      result,
      params.trustedLocalMediaToolNames,
    );
    if (
      params.sourceReplyDeliveryMode === "message_tool_only" &&
      parsed.text &&
      filteredMediaUrls.length === 0 &&
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        messagingToolSentTargets,
      })
    ) {
      return;
    }
    if (!parsed.text && filteredMediaUrls.length === 0) {
      return;
    }
    runBestEffortCallback({
      label: "tool result",
      log,
      callback: () =>
        params.onToolResult?.({
          text: parsed.text,
          mediaUrls: filteredMediaUrls.length ? filteredMediaUrls : undefined,
          ...(mediaArtifact?.audioAsVoice ? { audioAsVoice: true } : {}),
        }),
    });
  };
  const emitToolSummary = (toolName?: string, meta?: string) => {
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
      markdown: useMarkdown,
    });
    emitToolResultMessage(toolName, agg);
  };
  const emitToolOutput = (toolName?: string, meta?: string, output?: string, result?: unknown) => {
    if (!output) {
      return;
    }
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
      markdown: useMarkdown,
    });
    const message = `${agg}\n${formatToolOutputBlock(output)}`;
    emitToolResultMessage(toolName, message, result);
  };

  const stripBlockTags = (
    text: string,
    stateLocal: {
      thinking: boolean;
      final: boolean;
      inlineCode?: InlineCodeState;
      fence?: FenceScanState;
      reasoningInlineCode?: InlineCodeState;
      reasoningFence?: FenceScanState;
      reasoningPendingFenceFragment?: string;
      finalInlineCode?: InlineCodeState;
      finalFence?: FenceScanState;
      pendingFenceFragment?: string;
      pendingTagFragment?: string;
    },
    options?: { final?: boolean; completeMarkdownChunk?: boolean },
  ): string => {
    const input = `${stateLocal.pendingFenceFragment ?? ""}${stateLocal.pendingTagFragment ?? ""}${text}`;
    stateLocal.pendingFenceFragment = undefined;
    stateLocal.pendingTagFragment = undefined;
    if (!input) {
      return text;
    }

    const { text: fenceInput, pendingFenceFragment } = options?.final
      ? { text: input, pendingFenceFragment: undefined }
      : options?.completeMarkdownChunk
        ? { text: input, pendingFenceFragment: undefined }
        : splitTrailingFenceFragment(input, stateLocal.fence?.atLineStart ?? true);
    stateLocal.pendingFenceFragment = pendingFenceFragment;
    if (!fenceInput) {
      return "";
    }

    const inlineStateStart = stateLocal.inlineCode ?? createInlineCodeState();
    const fenceStateStart = stateLocal.fence;
    const initialCodeSpans = buildCodeSpanIndex(fenceInput, inlineStateStart, fenceStateStart);
    const { text: scanText, pendingTagFragment } = options?.final
      ? { text: fenceInput, pendingTagFragment: undefined }
      : splitTrailingBlockTagFragment(fenceInput, initialCodeSpans.isInside);
    stateLocal.pendingTagFragment = pendingTagFragment;
    if (!scanText) {
      return "";
    }
    const codeSpans = buildCodeSpanIndex(scanText, inlineStateStart, fenceStateStart);

    let processed = "";
    THINKING_TAG_SCAN_RE.lastIndex = 0;
    let lastIndex = 0;
    let lastCodeIndex = 0;
    let inThinking = stateLocal.thinking;
    // Hidden reasoning has its own code state: malformed hidden fences must not
    // mark later visible text as code, but literal close tags there stay hidden.
    let hiddenInlineState: InlineCodeState = stateLocal.reasoningInlineCode
      ? { ...stateLocal.reasoningInlineCode }
      : createInlineCodeState();
    let hiddenFenceState: FenceScanState | undefined = stateLocal.reasoningFence?.open
      ? {
          atLineStart: stateLocal.reasoningFence.atLineStart,
          open: { ...stateLocal.reasoningFence.open },
        }
      : stateLocal.reasoningFence
        ? { atLineStart: stateLocal.reasoningFence.atLineStart }
        : undefined;
    let hiddenPendingFenceFragment = stateLocal.reasoningPendingFenceFragment;
    stateLocal.reasoningPendingFenceFragment = undefined;
    const advanceHiddenCodeState = (segment: string) => {
      const hiddenInput = `${hiddenPendingFenceFragment ?? ""}${segment}`;
      hiddenPendingFenceFragment = undefined;
      if (!hiddenInput) {
        return;
      }
      const { text: hiddenFenceInput, pendingFenceFragment: pendingFenceFragmentLocal } =
        options?.final
          ? { text: hiddenInput, pendingFenceFragment: undefined }
          : options?.completeMarkdownChunk
            ? { text: hiddenInput, pendingFenceFragment: undefined }
            : splitTrailingFenceFragment(hiddenInput, hiddenFenceState?.atLineStart ?? true);
      hiddenPendingFenceFragment = pendingFenceFragmentLocal;
      if (!hiddenFenceInput) {
        return;
      }
      const next = buildCodeSpanIndex(hiddenFenceInput, hiddenInlineState, hiddenFenceState);
      hiddenInlineState = next.inlineState;
      hiddenFenceState = next.fenceState;
    };
    for (const match of scanText.matchAll(THINKING_TAG_SCAN_RE)) {
      const idx = match.index ?? 0;
      const isClose = match[1] === "/";
      if (inThinking) {
        advanceHiddenCodeState(scanText.slice(lastCodeIndex, idx));
      }
      const isInsideHiddenCode =
        inThinking && (hiddenInlineState.open || Boolean(hiddenFenceState?.open));
      lastCodeIndex = idx + match[0].length;
      if ((!inThinking && codeSpans.isInside(idx)) || isInsideHiddenCode) {
        if (inThinking) {
          advanceHiddenCodeState(match[0]);
        }
        continue;
      }
      if (!inThinking) {
        if (isClose) {
          const afterIndex = idx + match[0].length;
          const before = scanText.slice(lastIndex, idx);
          const after = scanText.slice(afterIndex);
          if (hasOrphanReasoningCloseBoundary({ before, after })) {
            processed = "";
          } else {
            processed += before;
          }
          lastIndex = afterIndex;
          continue;
        }
        processed += scanText.slice(lastIndex, idx);
        hiddenInlineState = createInlineCodeState();
        hiddenFenceState = undefined;
        hiddenPendingFenceFragment = undefined;
      }
      inThinking = !isClose;
      if (!inThinking) {
        hiddenInlineState = createInlineCodeState();
        hiddenFenceState = undefined;
        hiddenPendingFenceFragment = undefined;
      }
      lastIndex = idx + match[0].length;
    }
    if (inThinking) {
      advanceHiddenCodeState(scanText.slice(lastCodeIndex));
    }
    if (!inThinking) {
      processed += scanText.slice(lastIndex);
    }
    stateLocal.thinking = inThinking;
    stateLocal.reasoningInlineCode = inThinking ? hiddenInlineState : undefined;
    stateLocal.reasoningFence = inThinking ? hiddenFenceState : undefined;
    stateLocal.reasoningPendingFenceFragment = inThinking ? hiddenPendingFenceFragment : undefined;

    // If enforcement is disabled, we still strip the tags themselves to prevent
    // hallucinations (e.g. Minimax copying the style) from leaking, but we
    // do not enforce buffering/extraction logic.
    const finalCodeSpans = buildCodeSpanIndex(processed, inlineStateStart, fenceStateStart);
    if (!params.enforceFinalTag) {
      stateLocal.inlineCode = finalCodeSpans.inlineState;
      stateLocal.fence = finalCodeSpans.fenceState;
      return stripFinalTagsOutsideCodeSpans(processed, finalCodeSpans.isInside);
    }

    // If enforcement is enabled, only return text that appeared inside a <final> block.
    let result = "";
    let lastFinalIndex = 0;
    let inFinal = stateLocal.final;
    let everInFinal = stateLocal.final;

    for (const match of findFinalTagMatches(processed)) {
      const idx = match.index;
      if (finalCodeSpans.isInside(idx)) {
        continue;
      }
      const isClose = match.isClose;
      const isSelfClosing = match.isSelfClosing;

      if (isSelfClosing) {
        if (inFinal) {
          result += processed.slice(lastFinalIndex, idx);
          inFinal = false;
        } else {
          inFinal = true;
          everInFinal = true;
        }
        lastFinalIndex = idx + match.text.length;
      } else if (!inFinal && !isClose) {
        // Found <final> start tag.
        inFinal = true;
        everInFinal = true;
        lastFinalIndex = idx + match.text.length;
      } else if (inFinal && isClose) {
        // Found </final> end tag.
        result += processed.slice(lastFinalIndex, idx);
        inFinal = false;
        lastFinalIndex = idx + match.text.length;
      }
    }

    if (inFinal) {
      result += processed.slice(lastFinalIndex);
    }
    stateLocal.final = inFinal;

    // Strict Mode: If enforcing final tags, we MUST NOT return content unless
    // we have seen a <final> tag. Otherwise, we leak "thinking out loud" text
    // (e.g. "**Locating Manulife**...") that the model emitted without <think> tags.
    if (!everInFinal) {
      stateLocal.inlineCode = createInlineCodeState();
      stateLocal.fence = finalCodeSpans.fenceState;
      stateLocal.finalInlineCode = undefined;
      stateLocal.finalFence = undefined;
      return "";
    }

    // Hardened Cleanup: Remove any remaining <final> tags that might have been
    // missed (e.g. nested tags or hallucinations) to prevent leakage.
    const finalResultInlineStateStart = stateLocal.finalInlineCode ?? createInlineCodeState();
    const finalResultFenceStateStart = stateLocal.finalFence;
    const resultCodeSpans = buildCodeSpanIndex(
      result,
      finalResultInlineStateStart,
      finalResultFenceStateStart,
    );
    stateLocal.inlineCode = finalCodeSpans.inlineState;
    stateLocal.fence = finalCodeSpans.fenceState;
    stateLocal.finalInlineCode = inFinal ? resultCodeSpans.inlineState : undefined;
    stateLocal.finalFence = inFinal ? resultCodeSpans.fenceState : undefined;
    return stripFinalTagsOutsideCodeSpans(result, resultCodeSpans.isInside);
  };

  const stripFinalTagsOutsideCodeSpans = (text: string, isInside: (index: number) => boolean) => {
    let output = "";
    let lastIndex = 0;
    for (const match of findFinalTagMatches(text)) {
      const idx = match.index;
      if (isInside(idx)) {
        continue;
      }
      output += text.slice(lastIndex, idx);
      lastIndex = idx + match.text.length;
    }
    output += text.slice(lastIndex);
    return output;
  };
  const hasMessageToolOnlySourceDelivery = () =>
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    (state.messageToolOnlySourceReplyDelivered ||
      params.hasDeliveredMessageToolOnlySourceReply?.() === true ||
      messagingToolSourceReplyPayloads.length > 0);

  const emitBlockChunk = (
    text: string,
    options?: { assistantMessageIndex?: number; final?: boolean; completeMarkdownChunk?: boolean },
  ) => {
    if (state.suppressBlockChunks || params.silentExpected) {
      return;
    }
    // Strip <think> and <final> blocks across chunk boundaries to avoid leaking reasoning.
    // Also strip downgraded tool call text ([Tool Call: ...], [Historical context: ...], etc.).
    const blockReplyText = stripDowngradedToolCallText(
      stripBlockTags(text, state.blockState, {
        final: options?.final === true,
        completeMarkdownChunk: options?.completeMarkdownChunk === true,
      }),
    ).trimEnd();
    if (!blockReplyText) {
      return;
    }
    if (blockReplyText === state.lastBlockReplyText) {
      return;
    }
    const markBlockReplyTextHandled = () => {
      state.lastBlockReplyText = blockReplyText;
      state.lastDeliveredBlockReplyText = blockReplyText;
      state.toolExecutionSinceLastBlockReply = false;
    };
    if (hasMessageToolOnlySourceDelivery()) {
      markBlockReplyTextHandled();
      return;
    }
    let chunk = blockReplyText;
    let slicedPrefixReplay = false;
    const lastDeliveredBlockReplyText = state.lastDeliveredBlockReplyText;
    const blockReplySuffix = lastDeliveredBlockReplyText
      ? blockReplyText.slice(lastDeliveredBlockReplyText.length)
      : "";
    const prefixReplayCandidate = Boolean(
      state.blockReplyBreak === "text_end" &&
      state.toolExecutionSinceLastBlockReply &&
      lastDeliveredBlockReplyText &&
      lastDeliveredBlockReplyText.trimEnd().endsWith(":") &&
      blockReplyText.length > lastDeliveredBlockReplyText.length &&
      blockReplyText.startsWith(lastDeliveredBlockReplyText),
    );
    if (prefixReplayCandidate && !/^\s/.test(blockReplySuffix)) {
      chunk = blockReplySuffix;
      slicedPrefixReplay = true;
    }
    if (!chunk) {
      return;
    }

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    const normalizedChunk = normalizeTextForComparison(chunk);
    const normalizedReplaySuffix = prefixReplayCandidate
      ? normalizeTextForComparison(blockReplySuffix.trimStart())
      : "";
    const isMessagingDuplicate =
      isMessagingToolDuplicateNormalized(normalizedChunk, messagingToolSentTextsNormalized) ||
      (prefixReplayCandidate &&
        isMessagingToolDuplicateNormalized(
          normalizedReplaySuffix,
          messagingToolSentTextsNormalized,
        ));
    if (isMessagingDuplicate) {
      log.debug(
        `Skipping block reply - already sent via messaging tool: ${truncateUtf16Safe(chunk, 50)}...`,
      );
      if (prefixReplayCandidate) {
        markBlockReplyTextHandled();
      }
      return;
    }

    if (shouldSkipAssistantText(chunk)) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }

    if (!params.onBlockReply) {
      pushAssistantText(chunk);
      markBlockReplyTextHandled();
      return;
    }
    const splitResult = replyDirectiveAccumulator.consume(chunk);
    if (!splitResult) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }
    pushAssistantText(chunk);
    emitBlockReply(
      {
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      },
      {
        assistantMessageIndex: options?.assistantMessageIndex ?? state.assistantMessageIndex,
        consumePendingToolMedia:
          options?.final === true || Boolean(mediaUrls?.length || audioAsVoice),
      },
    );
    markBlockReplyTextHandled();
  };

  const consumeReplyDirectives = (text: string, options?: { final?: boolean }) =>
    replyDirectiveAccumulator.consume(text, options);
  const consumePartialReplyDirectives = (text: string, options?: { final?: boolean }) =>
    partialReplyDirectiveAccumulator.consume(text, options);

  const flushBlockReplyBuffer = (options?: {
    assistantMessageIndex?: number;
    final?: boolean;
  }): void | Promise<void> => {
    if (!params.onBlockReply) {
      return;
    }
    if (blockChunker?.hasBuffered()) {
      if (options?.final) {
        let pendingChunk: string | undefined;
        blockChunker.drain({
          force: true,
          emit: (text) => {
            if (pendingChunk !== undefined) {
              emitBlockChunk(pendingChunk, {
                assistantMessageIndex: options.assistantMessageIndex,
                completeMarkdownChunk: true,
              });
            }
            pendingChunk = text;
          },
        });
        if (pendingChunk !== undefined) {
          emitBlockChunk(pendingChunk, {
            assistantMessageIndex: options.assistantMessageIndex,
            completeMarkdownChunk: true,
            final: true,
          });
        }
      } else {
        blockChunker.drain({ force: true, emit: (text) => emitBlockChunk(text, options) });
      }
      blockChunker.reset();
    } else if (state.blockBuffer.length > 0) {
      emitBlockChunk(state.blockBuffer, options);
      state.blockBuffer = "";
    }
    if (options?.final) {
      emitBlockChunk("", options);
    }
    if (pendingBlockReplyTasks.size === 0) {
      return;
    }
    return (async () => {
      while (pendingBlockReplyTasks.size > 0) {
        await Promise.allSettled(pendingBlockReplyTasks);
      }
    })();
  };

  const emitReasoningStream = (text: string) => {
    if (params.silentExpected) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === state.lastStreamedReasoning) {
      return;
    }
    // Compute delta: new text since the last emitted reasoning.
    // Guard against non-prefix changes (e.g. trim altering earlier content).
    const prior = state.lastStreamedReasoning ?? "";
    const delta = trimmed.startsWith(prior) ? trimmed.slice(prior.length) : trimmed;
    state.lastStreamedReasoning = trimmed;

    // Emit-always: the thinking stream always reaches the bus and session
    // archive. /reasoning (streamReasoning) gates only the rendering hook
    // below; display surfaces (TUI showThinking, webchat isReasoning drops)
    // gate presentation on their side.
    emitAgentEvent({
      runId: params.runId,
      stream: "thinking",
      data: {
        text: trimmed,
        delta,
      },
    });

    // Message-tool-only delivery makes later reasoning private: once the
    // user-facing reply has gone out via the message tool, the channel shows
    // only what was explicitly sent, so trailing reasoning must stay out of the
    // render hook — uniformly, whether the thinking block rode in on a tool call
    // or arrived on its own. It still reaches the bus/archive above.
    if (state.streamReasoning && !hasMessageToolOnlySourceDelivery() && params.onReasoningStream) {
      runBestEffortCallback({
        label: "reasoning stream",
        log,
        callback: () =>
          params.onReasoningStream?.({
            text: trimmed,
            ...(state.reasoningMode === "stream" ? {} : { requiresReasoningProgressOptIn: true }),
          }),
      });
    }
  };

  const resetForCompactionRetry = () => {
    state.hadDeterministicSideEffect =
      state.hadDeterministicSideEffect === true ||
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        messagingToolSentTargets,
      }) ||
      state.successfulCronAdds > 0 ||
      state.acceptedSessionSpawns.length > 0 ||
      state.visibleBlockReplyCount > 0;
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    toolSummaryById.clear();
    state.itemActiveIds.clear();
    state.itemStartedCount = 0;
    state.itemCompletedCount = 0;
    // Compaction retries restart presentation state, not attempt-wide mutation truth.
    // Retain unresolved side effects so the retry cannot falsely finish as success.
    if (state.lastToolError?.mutatingAction !== true) {
      state.lastToolError = undefined;
    }
    messagingToolSentTexts.length = 0;
    messagingToolSentTextsNormalized.length = 0;
    messagingToolSentTargets.length = 0;
    messagingToolSentMediaUrls.length = 0;
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    state.successfulCronAdds = 0;
    state.heartbeatToolResponse = undefined;
    state.pendingMessagingMediaUrls.clear();
    state.pendingToolMediaUrls = [];
    state.pendingToolAudioAsVoice = false;
    state.pendingToolTrustedLocalMedia = false;
    state.visibleBlockReplyCount = 0;
    state.deferBlockReplyDelivery = typeof params.onBeforeTerminalDelivery === "function";
    clearDeferredAssistantEvents();
    clearDeferredBlockReplies();
    state.pendingAssistantReplyDirectives = undefined;
    state.deterministicApprovalPromptPending = false;
    state.deterministicApprovalPromptSent = false;
    state.lastDeliveredBlockReplyText = undefined;
    state.toolExecutionSinceLastBlockReply = false;
    // A retry is a new model attempt. A silent retry must not inherit the
    // completed assistant or pre-compaction context snapshot.
    currentAttemptAssistant = undefined;
    lastAssistantUsage = undefined;
    state.replayState = mergeEmbeddedRunReplayState(state.replayState, params.initialReplayState);
    state.livenessState = "working";
    resetAssistantMessageState(0);
  };

  const noteLastAssistant = (msg: AgentMessage) => {
    if (msg?.role === "assistant") {
      state.lastAssistant = msg;
    }
  };
  const noteCompletedAssistant = (msg: AgentMessage) => {
    if (msg?.role === "assistant") {
      // Context-engine projection may later replace or mutate transcript
      // objects. Final delivery needs the model event owned by this run.
      currentAttemptAssistant = structuredClone(msg) as AssistantMessage;
    }
  };

  const ctx: EmbeddedAgentSubscribeContext = {
    params,
    state,
    log,
    blockChunking,
    blockChunker,
    hookRunner: params.hookRunner,
    builtinToolNames: params.builtinToolNames,
    trustedLocalMediaToolNames: params.trustedLocalMediaToolNames,
    noteLastAssistant,
    noteCompletedAssistant,
    shouldEmitToolResult,
    shouldEmitToolOutput,
    emitToolSummary,
    emitToolOutput,
    stripBlockTags,
    emitBlockChunk,
    flushBlockReplyBuffer,
    emitAssistantStreamData,
    emitBlockReply,
    flushDeferredAssistantEvents,
    flushDeferredBlockReplies,
    clearDeferredAssistantEvents,
    clearDeferredBlockReplies,
    emitReasoningStream,
    consumeReplyDirectives,
    consumePartialReplyDirectives,
    resetAssistantMessageState,
    resetForCompactionRetry,
    finalizeAssistantTexts,
    trimMessagingToolSent,
    consumeToolSendReceipt: (toolCallId) =>
      consumeEmbeddedToolSendReceipt(params.session.sessionManager, toolCallId),
    ensureCompactionPromise,
    noteCompactionRetry,
    resolveCompactionRetry,
    maybeResolveCompactionWait,
    recordAssistantUsage,
    commitAssistantUsage,
    incrementCompactionCount,
    noteCompactionTokensAfter,
    getUsageTotals,
    getLastAssistantUsage,
    getCompactionCount: () => compactionCount,
    getLastCompactionTokensAfter: () => state.lastCompactionTokensAfter,
  };

  const sessionUnsubscribe = params.session.subscribe(createEmbeddedAgentSessionEventHandler(ctx));

  const unsubscribe = () => {
    if (state.unsubscribed) {
      return;
    }
    // Mark as unsubscribed FIRST to prevent waitForCompactionRetry from creating
    // new un-resolvable promises during teardown.
    state.unsubscribed = true;
    cleanupRunToolStartData(params.runId);
    // Reject pending compaction wait to unblock awaiting code.
    // Don't resolve, as that would incorrectly signal "compaction complete" when it's still in-flight.
    if (state.compactionRetryPromise) {
      log.debug(`unsubscribe: rejecting compaction wait runId=${params.runId}`);
      const reject = state.compactionRetryReject;
      state.compactionRetryResolve = undefined;
      state.compactionRetryReject = undefined;
      state.compactionRetryPromise = null;
      // Reject with AbortError so it's caught by isAbortError() check in cleanup paths
      const abortErr = new Error("Unsubscribed during compaction");
      abortErr.name = "AbortError";
      reject?.(abortErr);
    }
    // Cancel any in-flight compaction to prevent resource leaks when unsubscribing.
    // Only abort if compaction is actually running to avoid unnecessary work.
    if (params.session.isCompacting) {
      log.debug(`unsubscribe: aborting in-flight compaction runId=${params.runId}`);
      try {
        params.session.abortCompaction();
      } catch (err) {
        log.warn(`unsubscribe: compaction abort failed runId=${params.runId} err=${String(err)}`);
      }
    }
    sessionUnsubscribe();
  };

  return {
    assistantTexts,
    getCurrentAttemptAssistant: () =>
      currentAttemptAssistant ? structuredClone(currentAttemptAssistant) : undefined,
    getLastAssistantTextMessageIndex: () =>
      state.lastAssistantTextMessageIndex >= 0 ? state.lastAssistantTextMessageIndex : undefined,
    toolMetas,
    getAcceptedSessionSpawns: () => state.acceptedSessionSpawns.slice(),
    getLatestMcpAppChannelView: () =>
      state.latestMcpAppChannelView ? { ...state.latestMcpAppChannelView } : undefined,
    runToolLifecycle: async <T>(toolParams: {
      toolName: string;
      toolCallId: string;
      args: unknown;
      replaySafe?: boolean;
      hideFromChannelProgress?: boolean;
      execute: () => Promise<T>;
    }): Promise<T> => {
      await handleToolExecutionStart(ctx, {
        type: "tool_execution_start",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        args: toolParams.args,
        replaySafe: toolParams.replaySafe,
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      } as never);
      try {
        const result = await toolParams.execute();
        await handleToolExecutionEnd(ctx, {
          type: "tool_execution_end",
          toolName: toolParams.toolName,
          toolCallId: toolParams.toolCallId,
          isError: false,
          executionStarted: true,
          result,
          hideFromChannelProgress: toolParams.hideFromChannelProgress,
        } as never);
        return result;
      } catch (error) {
        await handleToolExecutionEnd(ctx, {
          type: "tool_execution_end",
          toolName: toolParams.toolName,
          toolCallId: toolParams.toolCallId,
          isError: true,
          executionStarted: true,
          result: buildToolLifecycleErrorResult(error),
          hideFromChannelProgress: toolParams.hideFromChannelProgress,
        } as never);
        throw error;
      }
    },
    unsubscribe,
    setTerminalLifecycleMeta: (meta: {
      replayInvalid?: boolean;
      livenessState?: EmbeddedRunLivenessState;
      stopReason?: string;
      yielded?: boolean;
      timeoutPhase?: AgentRunTimeoutPhase;
      providerStarted?: boolean;
      aborted?: boolean;
    }) => {
      if (typeof meta.replayInvalid === "boolean") {
        state.replayState = { ...state.replayState, replayInvalid: meta.replayInvalid };
      }
      if (meta.livenessState) {
        state.livenessState = meta.livenessState;
      }
      if (typeof meta.stopReason === "string") {
        state.terminalStopReason = meta.stopReason;
      }
      if (typeof meta.yielded === "boolean") {
        state.yielded = meta.yielded;
      }
      if (meta.timeoutPhase) {
        state.timeoutPhase = meta.timeoutPhase;
      }
      if (typeof meta.providerStarted === "boolean") {
        state.providerStarted = meta.providerStarted;
      }
      if (typeof meta.aborted === "boolean") {
        state.terminalAborted = meta.aborted;
      }
    },
    isCompacting: () => state.compactionInFlight || state.pendingCompactionRetry > 0,
    isCompactionInFlight: () => state.compactionInFlight,
    getMessagingToolSentTexts: () => messagingToolSentTexts.slice(),
    getMessagingToolSentMediaUrls: () => messagingToolSentMediaUrls.slice(),
    getMessagingToolSentTargets: () => messagingToolSentTargets.slice(),
    getMessagingToolSourceReplyPayloads: () => messagingToolSourceReplyPayloads.slice(),
    getHeartbeatToolResponse: () =>
      state.heartbeatToolResponse ? { ...state.heartbeatToolResponse } : undefined,
    getPendingToolMediaReply: () => readPendingToolMediaReply(state),
    hasToolMediaBlockReply: () => state.hasToolMediaBlockReply,
    getVisibleBlockReplyCount: () => state.visibleBlockReplyCount,
    getSuccessfulCronAdds: () => state.successfulCronAdds,
    getReplayState: () => ({ ...state.replayState }),
    // Returns true if any messaging tool successfully sent a message.
    // Used to suppress agent's confirmation text (e.g., "Respondi no Telegram!")
    // which is generated AFTER the tool sends the actual answer.
    didSendViaMessagingTool: () =>
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        messagingToolSentTargets,
      }),
    didSendDeterministicApprovalPrompt: () => state.deterministicApprovalPromptSent,
    getLastToolError: () => (state.lastToolError ? { ...state.lastToolError } : undefined),
    getUsageTotals,
    getLastAssistantUsage,
    getCompactionCount: () => compactionCount,
    getLastCompactionTokensAfter: () => state.lastCompactionTokensAfter,
    waitForPendingEvents: () => state.pendingEventChain ?? Promise.resolve(),
    getItemLifecycle: () => ({
      startedCount: state.itemStartedCount,
      completedCount: state.itemCompletedCount,
      activeCount: state.itemActiveIds.size,
    }),
    waitForCompactionRetry: () => {
      // Reject after unsubscribe so callers treat it as cancellation, not success
      if (state.unsubscribed) {
        const err = new Error("Unsubscribed during compaction wait");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
        ensureCompactionPromise();
        return state.compactionRetryPromise ?? Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        queueMicrotask(() => {
          if (state.unsubscribed) {
            const err = new Error("Unsubscribed during compaction wait");
            err.name = "AbortError";
            reject(err);
            return;
          }
          if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
            ensureCompactionPromise();
            void (state.compactionRetryPromise ?? Promise.resolve()).then(resolve, reject);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
