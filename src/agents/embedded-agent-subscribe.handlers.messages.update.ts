/**
 * Handles assistant message deltas, reasoning, directives, and block replies.
 */
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { AssistantMessage } from "../llm/types.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import { resolveAssistantMessagePhase } from "../shared/chat-message-content.js";
import { updateLiveEditDiffProgress } from "./embedded-agent-live-edit-diff.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { capturePendingAssistantUsage } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import {
  hasAssistantVisibleReply,
  mergeReplyDirectiveResults,
  recordPendingAssistantReplyDirectives,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  appendBlockReplyChunk,
  buildAssistantStreamData,
  copyPartialBlockState,
  emitAssistantMessageStart,
  emitReasoningEnd,
  hasMessageToolOnlySourceDelivery,
  isAnthropicAssistantMessage,
  isOpenAiCompletionsAssistantMessage,
  isResponsesApiAssistantMessage,
  isSubscribeTranscriptOnlyOpenClawAssistantMessage,
  openReasoningStream,
  replaceBlockReplyBuffer,
  resolveAssistantStreamContentIndex,
  resolveAssistantStreamItemId,
  resolveAssistantTextChunk,
  resolveCurrentSourceMessagingToolPartial,
  resolveStreamVisibleText,
  resolveStreamingReplyText,
  resolveTextAppendDelta,
  scopeAssistantMessageToStreamBlock,
  shouldSuppressAssistantVisibleOutput,
  shouldSuppressDeterministicApprovalOutput,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";
import {
  extractAssistantCommentaryText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  extractThinkingFromTaggedStream,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";

const REASONING_TAG_RE = /<\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b/i;

export function handleMessageUpdate(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  ctx.noteLastAssistant(msg);
  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";
  const liveEditDiff = updateLiveEditDiffProgress(ctx.state.liveEditDiffStateById, assistantRecord);
  if (liveEditDiff) {
    const data = { phase: "input_delta", ...liveEditDiff };
    emitAgentEvent({ runId: ctx.params.runId, stream: "tool", data });
    runBestEffortCallback({
      label: "live edit diff agent event",
      log: ctx.log,
      callback: () => ctx.params.onAgentEvent?.({ stream: "tool", data }),
    });
  }
  const eventAssistantMessage =
    assistantRecord?.partial && typeof assistantRecord.partial === "object"
      ? (assistantRecord.partial as AssistantMessage)
      : msg;
  const isResponsesTextEvent =
    isResponsesApiAssistantMessage(eventAssistantMessage) &&
    (evtType === "text_start" || evtType === "text_delta" || evtType === "text_end");
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(msg);
  if (suppressVisibleAssistantOutput && !isResponsesTextEvent) {
    const commentaryText = coerceChatContentText(extractAssistantCommentaryText(msg));
    if (commentaryText) {
      appendRawStream({
        ts: Date.now(),
        event: "assistant_text_stream",
        runId: ctx.params.runId,
        sessionId: (ctx.params.session as { id?: string }).id,
        evtType: "commentary_update",
        delta: "",
        content: commentaryText,
      });
      ctx.emitAssistantStreamData(
        buildAssistantStreamData({ text: commentaryText, replace: true, phase: "commentary" }),
      );
    }
    return;
  }
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);

  const assistantPhase = resolveAssistantMessagePhase(msg);

  if (evtType === "text_end" || evtType === "done" || evtType === "error") {
    capturePendingAssistantUsage(ctx, evt);
    if (evtType === "done" || evtType === "error") {
      ctx.commitAssistantUsage();
    }
  }

  if (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      (evtType === "thinking_start" || evtType === "thinking_delta")
    ) {
      openReasoningStream(ctx);
    }
    const thinkingDelta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
    const thinkingContent =
      typeof assistantRecord?.content === "string" ? assistantRecord.content : "";
    appendRawStream({
      ts: Date.now(),
      event: "assistant_thinking_stream",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      evtType,
      delta: thinkingDelta,
      content: thinkingContent,
    });
    // Emit-always: emitReasoningStream always reaches the bus/archive; the
    // streamReasoning rendering hook and message_tool_only source suppression
    // are gated downstream (dispatch wrapProgressCallback, #92738), so emission
    // here stays unconditional.
    // Prefer full partial-message thinking when available; fall back to event payloads.
    const partialThinking = extractAssistantThinking(msg);
    ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta);
    if (evtType === "thinking_end" && !suppressMessageToolOnlySourceReplyOutput) {
      // Mirror the open gate above: when message-tool-only delivery has made the
      // reasoning lane private, do not force-open it just to close it — that
      // would fire the lane's end hook (onReasoningEnd) for a lane that never
      // rendered, leaking the boundary signal.
      if (!ctx.state.reasoningStreamOpen) {
        openReasoningStream(ctx);
      }
      emitReasoningEnd(ctx);
    }
    return;
  }

  if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    return;
  }

  const delta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const content = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";

  appendRawStream({
    ts: Date.now(),
    event: "assistant_text_stream",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    evtType,
    delta,
    content,
  });

  const chunk = resolveAssistantTextChunk({
    evtType,
    delta,
    content,
    accumulatedText: ctx.state.deltaBuffer,
  });

  const partialAssistant = eventAssistantMessage;
  const streamContentIndex = resolveAssistantStreamContentIndex(assistantRecord?.contentIndex);
  const streamItemId = resolveAssistantStreamItemId({
    contentIndex: streamContentIndex,
    message: partialAssistant,
  });
  const streamAssistant = scopeAssistantMessageToStreamBlock(
    partialAssistant,
    streamContentIndex,
    streamItemId,
  );
  const deliveryPhase = resolveAssistantMessagePhase(streamAssistant);
  const isPhasePendingResponsesTextItem =
    evtType !== "text_end" &&
    !deliveryPhase &&
    Boolean(streamItemId) &&
    isResponsesApiAssistantMessage(partialAssistant);
  // These transports resolve commentary only at the tool boundary. Withhold
  // early unphased deltas from durable block replies until that decision exists.
  const isPhasePendingAnthropicText =
    evtType !== "text_end" && !deliveryPhase && isAnthropicAssistantMessage(partialAssistant);
  const isCompletionsAssistant = isOpenAiCompletionsAssistantMessage(partialAssistant);
  const isPhasePendingCompletionsText = !deliveryPhase && isCompletionsAssistant;
  const isReasoningCompletionsText =
    isCompletionsAssistant && partialAssistant.openclawDelivery?.textPhaseRequiresTerminal === true;
  const hasResponsesContentIndex =
    streamContentIndex !== undefined && isResponsesApiAssistantMessage(partialAssistant);
  let streamItemChanged = false;
  let deliveryItemId = streamItemId;
  if (
    (deliveryPhase || isPhasePendingResponsesTextItem || hasResponsesContentIndex) &&
    (streamContentIndex !== undefined || streamItemId)
  ) {
    const previousStreamContentIndex = ctx.state.lastAssistantStreamContentIndex;
    const previousStreamItemId = ctx.state.lastAssistantStreamItemId;
    const contentIndexChanged =
      previousStreamContentIndex !== undefined &&
      streamContentIndex !== undefined &&
      previousStreamContentIndex !== streamContentIndex;
    const itemIdChangedWithoutIndexes =
      (previousStreamContentIndex === undefined || streamContentIndex === undefined) &&
      Boolean(previousStreamItemId && streamItemId && previousStreamItemId !== streamItemId);
    if (contentIndexChanged || itemIdChangedWithoutIndexes) {
      streamItemChanged = true;
      void ctx.flushBlockReplyBuffer({ assistantMessageIndex: ctx.state.assistantMessageIndex });
      ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
      emitAssistantMessageStart(ctx);
    } else if (
      previousStreamContentIndex !== undefined &&
      streamContentIndex === previousStreamContentIndex &&
      previousStreamItemId
    ) {
      // Snapshot-extension items can rotate provider ids while retaining one logical block.
      // Keep the original live key so downstream commentary accumulators do not split it.
      deliveryItemId = previousStreamItemId;
    }
    ctx.state.lastAssistantStreamContentIndex = streamContentIndex;
    ctx.state.lastAssistantStreamItemId = deliveryItemId;
  }
  // Responses text_start snapshots may already contain text replayed by the first delta.
  // Keep starts lifecycle-only so commentary and final-answer lanes consume each byte once.
  if (evtType === "text_start" && isResponsesApiAssistantMessage(partialAssistant)) {
    return;
  }
  if (deliveryPhase === "commentary") {
    const isResponsesCommentary = isResponsesApiAssistantMessage(partialAssistant);
    const hadResponsesCommentaryText = isResponsesCommentary && Boolean(ctx.state.deltaBuffer);
    if (isResponsesCommentary && chunk) {
      // Keep cumulative end events monotonic without feeding commentary into reply buffers.
      ctx.state.deltaBuffer += chunk;
      ctx.state.deltaBufferIsCommentary = true;
    }
    const commentaryText =
      !chunk && (!isResponsesCommentary || !hadResponsesCommentaryText)
        ? coerceChatContentText(extractAssistantCommentaryText(streamAssistant))
        : undefined;
    const commentaryData = chunk
      ? buildAssistantStreamData({ delta: chunk, phase: "commentary", itemId: deliveryItemId })
      : commentaryText
        ? buildAssistantStreamData({
            text: commentaryText,
            replace: true,
            phase: "commentary",
            itemId: deliveryItemId,
          })
        : undefined;
    if (commentaryData) {
      ctx.emitAssistantStreamData(commentaryData);
    }
    return;
  }
  if (isPhasePendingResponsesTextItem) {
    return;
  }
  // Subagents have no live consumer; their final result is delivered from
  // message_end. Keep accumulating deltaBuffer, but skip per-chunk visible-text
  // parsing so long parallel subagent streams do not monopolize the event loop.
  const skipLiveStream = ctx.params.suppressLiveStreamOutput === true;
  const shouldUsePhaseAwareBlockReply = Boolean(deliveryPhase);

  // A completions stream cannot classify text interrupted by later reasoning
  // until terminal. Keep that text out of live reply lanes until its phase resolves.
  if (isReasoningCompletionsText) {
    return;
  }

  if (chunk) {
    ctx.state.deltaBuffer += chunk;
    ctx.state.deltaBufferIsCommentary = false;
    if (!skipLiveStream && !shouldUsePhaseAwareBlockReply) {
      if (!isPhasePendingAnthropicText && !isPhasePendingCompletionsText) {
        appendBlockReplyChunk(ctx, chunk);
      }
    }
  }

  if (skipLiveStream) {
    return;
  }

  // Handle partial <think> tags: stream whatever reasoning is visible so far.
  // Emit-always: emitReasoningStream reaches the bus/archive; rendering +
  // message_tool_only suppression are gated downstream (#92738).
  ctx.emitReasoningStream(
    extractThinkingFromTaggedStream(ctx.state.deltaBuffer, ctx.state.thinkingTagStream),
  );
  const wasThinking = ctx.state.partialBlockState.thinking;
  let visibleDelta = "";
  // A text_start partial may already contain text that the following text_delta replays.
  // Use starts only for lifecycle boundaries; consume their text from delta/end events.
  const shouldReadScopedPartialText =
    streamItemChanged || (shouldUsePhaseAwareBlockReply && (evtType === "text_end" || !chunk));
  let next = shouldReadScopedPartialText
    ? coerceChatContentText(extractAssistantVisibleText(streamAssistant)).trim()
    : "";
  let nextRawStreamText = next;
  let shouldPersistRawStreamText = false;
  if (shouldUsePhaseAwareBlockReply && !next && deliveryPhase === "final_answer" && chunk) {
    visibleDelta = ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
      final: evtType === "text_end",
    });
    const streamVisibleText = resolveStreamVisibleText({
      previousRawText: ctx.state.lastStreamedAssistant ?? "",
      visibleDelta,
    });
    const previousVisibleText = sanitizeAssistantVisibleStreamText(
      ctx.state.lastStreamedAssistant ?? "",
    ).trim();
    next = sanitizeAssistantVisibleStreamText(streamVisibleText.rawText).trim();
    visibleDelta = resolveTextAppendDelta(previousVisibleText, next);
    nextRawStreamText = streamVisibleText.rawText;
    shouldPersistRawStreamText = true;
  } else if (!next && deliveryPhase !== "final_answer") {
    const pendingTagFragment = ctx.state.partialBlockState.pendingTagFragment;
    const shouldRecomputeFullStream = Boolean(pendingTagFragment) || REASONING_TAG_RE.test(chunk);
    if (shouldRecomputeFullStream) {
      const recomputeState: EmbeddedAgentSubscribeState["partialBlockState"] = {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      };
      const recomputedRawText = ctx.stripBlockTags(ctx.state.deltaBuffer, recomputeState, {
        final: evtType === "text_end",
      });
      const previousRawText = ctx.state.lastStreamedAssistant ?? "";
      const isFullStreamReplacement = !recomputedRawText.startsWith(previousRawText);
      next = recomputedRawText.trim();
      visibleDelta = isFullStreamReplacement
        ? recomputedRawText
        : recomputedRawText.slice(previousRawText.length);
      nextRawStreamText = recomputedRawText;
      copyPartialBlockState(ctx.state.partialBlockState, recomputeState);
    } else {
      visibleDelta =
        chunk || evtType === "text_end"
          ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
              final: evtType === "text_end",
            })
          : "";
      if (ctx.state.partialBlockState.pendingTagFragment) {
        visibleDelta = "";
        next = ctx.state.lastStreamedAssistantCleaned ?? "";
        nextRawStreamText = ctx.state.lastStreamedAssistant ?? "";
      } else {
        const streamVisibleText = resolveStreamVisibleText({
          previousRawText: ctx.state.lastStreamedAssistant ?? "",
          visibleDelta,
        });
        next = streamVisibleText.visibleText;
        nextRawStreamText = streamVisibleText.rawText;
      }
    }
  } else if (next && (chunk || evtType === "text_end")) {
    visibleDelta = ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
      final: evtType === "text_end",
    });
  }
  if (next) {
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      !wasThinking &&
      ctx.state.partialBlockState.thinking
    ) {
      openReasoningStream(ctx);
    }
    // Detect when thinking block ends (</think> tag processed)
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      wasThinking &&
      !ctx.state.partialBlockState.thinking
    ) {
      emitReasoningEnd(ctx);
    }
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const finalParsedDelta =
      evtType === "text_end" ? ctx.consumePartialReplyDirectives("", { final: true }) : null;
    const parsedStreamDirectives = mergeReplyDirectiveResults(parsedDelta, finalParsedDelta);
    if (shouldUsePhaseAwareBlockReply) {
      recordPendingAssistantReplyDirectives(ctx.state, parsedStreamDirectives);
    }
    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
    const cleanedText = resolveStreamingReplyText({
      evtType,
      next,
      previousRawText: ctx.state.lastStreamedAssistant ?? "",
      previousCleaned,
      visibleDelta,
      parsedStreamDirectives,
      shouldUsePhaseAwareBlockReply,
    });
    const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedStreamDirectives ?? {});
    const hasAudio = Boolean(parsedStreamDirectives?.audioAsVoice);

    let shouldEmit;
    let deltaText = "";
    let replace = false;
    if (!hasAssistantVisibleReply({ text: cleanedText, mediaUrls, audioAsVoice: hasAudio })) {
      shouldEmit = false;
    } else {
      replace = Boolean(previousCleaned && !cleanedText.startsWith(previousCleaned));
      deltaText = replace ? "" : cleanedText.slice(previousCleaned.length);
      shouldEmit = replace
        ? cleanedText !== previousCleaned || hasMedia || hasAudio
        : Boolean(deltaText || hasMedia || hasAudio);
    }

    if (shouldUsePhaseAwareBlockReply) {
      if (replace) {
        ctx.state.blockBuffer = "";
        ctx.blockChunker?.reset();
      }
      const blockReplyChunk = replace ? cleanedText : deltaText;
      if (blockReplyChunk) {
        appendBlockReplyChunk(ctx, blockReplyChunk);
      }

      if (evtType === "text_end" && !ctx.state.lastBlockReplyText && cleanedText) {
        replaceBlockReplyBuffer(ctx, cleanedText);
      }
    } else if (streamItemChanged && !chunk) {
      // An unphased equal/shrinking Responses item can end without a delta.
      // Rebuild its block buffer from the scoped snapshot after the boundary reset.
      appendBlockReplyChunk(ctx, cleanedText);
    }

    ctx.state.lastStreamedAssistant = nextRawStreamText;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;

    if (
      ctx.params.silentExpected ||
      suppressDeterministicApprovalOutput ||
      suppressMessageToolOnlySourceReplyOutput
    ) {
      shouldEmit = false;
    }

    if (shouldEmit) {
      const currentSourcePartial =
        ctx.params.sourceReplyDeliveryMode !== "message_tool_only"
          ? resolveCurrentSourceMessagingToolPartial(ctx.state, {
              evtType,
              text: cleanedText,
              visibleDelta,
            })
          : { hold: false, text: cleanedText };
      const releaseHeldSnapshot = currentSourcePartial.text !== cleanedText;
      const data = buildAssistantStreamData({
        text: currentSourcePartial.text,
        delta: releaseHeldSnapshot ? currentSourcePartial.text : deltaText,
        replace: releaseHeldSnapshot || replace,
        mediaUrls,
        phase: deliveryPhase ?? assistantPhase,
      });
      ctx.emitAssistantStreamData(data, { emitPartialReply: !currentSourcePartial.hold });
      ctx.state.emittedAssistantUpdate = true;
    }
  } else if (shouldPersistRawStreamText) {
    ctx.state.lastStreamedAssistant = nextRawStreamText;
  }

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    ctx.params.onBlockReply &&
    ctx.blockChunking &&
    ctx.state.blockReplyBreak === "text_end"
  ) {
    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
  }

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    evtType === "text_end" &&
    ctx.state.blockReplyBreak === "text_end"
  ) {
    const assistantMessageIndex = ctx.state.assistantMessageIndex;
    void Promise.resolve()
      .then(() => ctx.flushBlockReplyBuffer({ assistantMessageIndex, final: true }))
      .catch((err: unknown) => {
        ctx.log.debug(`text_end block reply flush failed: ${String(err)}`);
      });
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedSubscribeMessagesTestApi")
  ] = {
    buildAssistantStreamData,
    recordPendingAssistantReplyDirectives,
    resolveCurrentSourceMessagingToolPartial,
  };
}
