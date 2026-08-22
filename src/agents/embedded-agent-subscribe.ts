import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
/**
 * Subscribes to embedded-agent sessions and streams formatted replies/events.
 */
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { emitAgentEventIfCurrent } from "../infra/agent-events.js";
import { recordAgentRunOutputTokens } from "../infra/agent-run-usage.js";
import type { AssistantMessage } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseInlineDirectives } from "../utils/directive-tags.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./embedded-agent-runner/delivery-evidence.js";
import { mergeEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import { consumeEmbeddedToolReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import type { EmbeddedRunLivenessState } from "./embedded-agent-runner/types.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { createEmbeddedAgentSessionEventHandler } from "./embedded-agent-subscribe.handlers.js";
import { readPendingToolMediaReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  cleanupRunToolStartData,
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { createEmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import { createStreamRendering } from "./embedded-agent-subscribe.stream-rendering.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-tool-media.js";
import { buildToolLifecycleErrorResult } from "./embedded-agent-tool-results.js";
import { stripDowngradedToolCallText } from "./embedded-agent-utils.js";
import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";
import type { AgentMessage } from "./runtime/index.js";
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "./usage.js";

const embeddedLog = createSubsystemLogger("agent/embedded");

function resolveEmbeddedAgentSessionLogger(messageChannel?: string) {
  const normalizedChannel = normalizeMessageChannel(messageChannel);
  if (normalizedChannel && isDeliverableMessageChannel(normalizedChannel)) {
    return createSubsystemLogger(`gateway/channels/${normalizedChannel}`);
  }
  return embeddedLog;
}

export function subscribeEmbeddedAgentSession(params: SubscribeEmbeddedAgentSessionParams) {
  const log = resolveEmbeddedAgentSessionLogger(params.messageChannel);
  const toolResultFormat = params.toolResultFormat ?? "markdown";
  const useMarkdown = toolResultFormat === "markdown";
  const state: EmbeddedAgentSubscribeState = createEmbeddedAgentSubscribeState(params);
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
  const replyDelivery = createReplyDelivery({ params, state, log });
  const {
    clearDeferredAssistantEvents,
    clearDeferredBlockReplies,
    emitAssistantStreamData,
    emitBlockReply,
    finalizeAssistantTexts,
    flushDeferredAssistantEvents,
    flushDeferredBlockReplies,
  } = replyDelivery;

  // ── Messaging tool duplicate detection ──────────────────────────────────────
  // Track texts sent via messaging tools to suppress duplicate block replies.
  // Only committed (successful) texts are checked - pending texts are tracked
  // to support commit logic but not used for suppression (avoiding lost messages on tool failure).
  // These tools can send messages via sendMessage/threadReply actions (or sessions_send with message).
  const MAX_MESSAGING_SENT_TEXTS = 200;
  const MAX_CURRENT_SOURCE_MESSAGING_SENT_TEXTS = 200;
  const MAX_MESSAGING_SENT_TARGETS = 200;
  const MAX_MESSAGING_SENT_MEDIA_URLS = 200;
  const MAX_MESSAGING_SOURCE_REPLY_PAYLOADS = 200;
  const trimMessagingToolSent = () => {
    if (messagingToolSentTexts.length > MAX_MESSAGING_SENT_TEXTS) {
      const overflow = messagingToolSentTexts.length - MAX_MESSAGING_SENT_TEXTS;
      messagingToolSentTexts.splice(0, overflow);
      messagingToolSentTextsNormalized.splice(0, overflow);
    }
    if (
      state.currentSourceMessagingToolSentTextsNormalized.length >
      MAX_CURRENT_SOURCE_MESSAGING_SENT_TEXTS
    ) {
      const overflow =
        state.currentSourceMessagingToolSentTextsNormalized.length -
        MAX_CURRENT_SOURCE_MESSAGING_SENT_TEXTS;
      state.currentSourceMessagingToolSentTextsNormalized.splice(0, overflow);
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
  const emitToolSummary = (
    toolName: string | undefined,
    meta: string | undefined,
    commandBearing: boolean,
  ) => {
    const visibleMeta = params.verboseLevel === "full" || !commandBearing ? meta : undefined;
    const agg = formatToolAggregate(toolName, visibleMeta ? [visibleMeta] : undefined, {
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

  const streamRendering = createStreamRendering({
    params,
    state,
    log,
    blockChunker,
    emitBlockReply: replyDelivery.emitBlockReply,
    pendingBlockReplyTasks: replyDelivery.pendingBlockReplyTasks,
    pushAssistantText: replyDelivery.pushAssistantText,
    shouldSkipAssistantText: replyDelivery.shouldSkipAssistantText,
  });
  const {
    consumePartialReplyDirectives,
    consumeReplyDirectives,
    emitBlockChunk,
    emitReasoningStream,
    flushBlockReplyBuffer,
    resetAssistantMessageState,
    stripBlockTags,
  } = streamRendering;

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
    state.liveEditDiffStateById.clear();
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
    state.currentSourceMessagingToolSentTextsNormalized.length = 0;
    messagingToolSentTargets.length = 0;
    messagingToolSentMediaUrls.length = 0;
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    state.successfulCronAdds = 0;
    state.heartbeatToolResponse = undefined;
    state.pendingMessagingMediaUrls.clear();
    state.pendingToolMediaUrls = [];
    state.pendingToolMediaAttachments = [];
    state.pendingToolMediaTrustByUrl.clear();
    state.pendingToolAudioAsVoice = false;
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

  // Re-filter the full raw buffer. Reusing live scanner state would hide the
  // visible prefix when timeout interrupts an open <think> or <final> block.
  const finalizeFlushedAssistantText = (text: string) =>
    stripDowngradedToolCallText(
      stripBlockTags(
        text,
        {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        { final: true },
      ),
    ).trimEnd();

  // Settlement calls this only for the final, failure-free run-budget terminal.
  // Retain and re-filter the full buffer so queued suffixes keep hidden-tag
  // context; replace live chunks instead of appending cumulative text twice.
  const flushPartialAssistantText = () => {
    const text = state.deltaBuffer;
    if (!text) {
      return;
    }
    if (state.deltaBufferIsCommentary) {
      state.hasFlushedPartialText = false;
      return;
    }
    const visibleText = finalizeFlushedAssistantText(text);
    if (assistantTexts.length > state.assistantTextBaseline || state.hasFlushedPartialText) {
      replyDelivery.replaceCurrentAssistantText(visibleText);
    } else if (visibleText) {
      replyDelivery.pushAssistantText(visibleText);
    }
    state.hasFlushedPartialText = Boolean(visibleText);
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
      consumeEmbeddedToolReceipt(params.session.sessionManager, toolCallId),
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
    state.liveEditDiffStateById.clear();
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
    getLatestMcpConnectAction: () =>
      state.latestMcpConnectAction ? { ...state.latestMcpConnectAction } : undefined,
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
    getAssistantTurnCount: () => state.assistantTurnCount,
    waitForPendingEvents: replyDelivery.waitForPendingEvents,
    flushPartialAssistantText,
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
