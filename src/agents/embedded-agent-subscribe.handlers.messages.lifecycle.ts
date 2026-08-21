import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
/**
 * Handles assistant message lifecycle boundaries, final reconciliation, and usage.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { AssistantMessage } from "../llm/types.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import { resolveAssistantMessagePhase } from "../shared/chat-message-content.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers.js";
import { hasAssistantVisibleReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  buildAssistantStreamData,
  emitAssistantMessageStart,
  extractStandaloneMessageToolText,
  hasMessageToolOnlySourceDelivery,
  isOpenAiCompletionsAssistantMessage,
  isResponsesApiAssistantMessage,
  isSubscribeTranscriptOnlyOpenClawAssistantMessage,
  scopeAssistantMessageToStreamBlock,
  shouldSuppressAssistantVisibleOutput,
  shouldSuppressDeterministicApprovalOutput,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";
import { warnIfAssistantEmittedSuspiciousText } from "./embedded-agent-subscribe.tool-text-diagnostics.js";
import {
  createThinkingTagStreamState,
  extractAssistantCommentaryText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  extractEmbeddedAssistantText,
  extractThinkingFromTaggedText,
  promoteThinkingTagsToBlocks,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type NormalizedUsage,
  type UsageLike,
} from "./usage.js";

export function preservePendingAssistantUsage(
  message: AssistantMessage,
  pendingUsage: NormalizedUsage | undefined,
): AssistantMessage {
  if (
    isSubscribeTranscriptOnlyOpenClawAssistantMessage(message) ||
    !hasNonzeroUsage(pendingUsage)
  ) {
    return message;
  }
  const messageUsage = normalizeUsage((message as { usage?: UsageLike }).usage);
  if (hasNonzeroUsage(messageUsage)) {
    return message;
  }

  // Pending usage resets at each assistant-message boundary, so it belongs to
  // this final snapshot. Only replace missing/zero usage; provider totals win.
  const input = pendingUsage.input ?? 0;
  const output = pendingUsage.output ?? 0;
  const cacheRead = pendingUsage.cacheRead ?? 0;
  const cacheWrite = pendingUsage.cacheWrite ?? 0;
  message.usage = {
    ...makeZeroUsageSnapshot(),
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(pendingUsage.contextUsage ? { contextUsage: { ...pendingUsage.contextUsage } } : {}),
    totalTokens: pendingUsage.total ?? input + output + cacheRead + cacheWrite,
    ...(pendingUsage.reasoningTokens !== undefined
      ? { reasoningTokens: pendingUsage.reasoningTokens }
      : {}),
  };
  return message;
}

export function capturePendingAssistantUsage(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
): void {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }
  const assistantRecord =
    evt.assistantMessageEvent && typeof evt.assistantMessageEvent === "object"
      ? (evt.assistantMessageEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";
  if (evtType === "text_end" || evtType === "done" || evtType === "error") {
    ctx.recordAssistantUsage(assistantRecord);
  }
}

export function resetPendingAssistantUsage(
  ctx: EmbeddedAgentSubscribeContext,
  message: AgentMessage,
): void {
  if (message?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(message)) {
    return;
  }
  ctx.state.pendingAssistantUsage = undefined;
  ctx.state.assistantUsageCommitted = false;
}

export function handleMessageStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
  // ASSUME: `message_start` is the only reliable boundary for “new assistant message begins”.
  // Start-of-message is a safer reset point than message_end: some providers
  // may deliver late text_end updates after message_end, which would otherwise
  // re-trigger block replies.
  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
  // Use assistant message_start as the earliest "writing" signal for typing.
  emitAssistantMessageStart(ctx);
}

/** Handles assistant message deltas, reasoning, directives, and block replies. */

export function handleMessageEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
): void | Promise<void> {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  // Transcript-only messages never reach the provider, so this counts exactly
  // the completed model round trips consumers see as `assistantTurns`.
  ctx.state.assistantTurnCount += 1;
  const assistantMessage = preservePendingAssistantUsage(msg, ctx.state.pendingAssistantUsage);
  const assistantPhase = resolveAssistantMessagePhase(assistantMessage);
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(assistantMessage);
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);
  ctx.noteLastAssistant(assistantMessage);
  ctx.noteCompletedAssistant(assistantMessage);
  ctx.recordAssistantUsage((assistantMessage as { usage?: unknown }).usage);
  ctx.commitAssistantUsage();
  if (suppressVisibleAssistantOutput) {
    const isResponsesCommentary = isResponsesApiAssistantMessage(assistantMessage);
    const commentaryMessage = isResponsesCommentary
      ? scopeAssistantMessageToStreamBlock(
          assistantMessage as AssistantMessage,
          ctx.state.lastAssistantStreamContentIndex,
          ctx.state.lastAssistantStreamItemId,
        )
      : assistantMessage;
    const commentaryText = coerceChatContentText(extractAssistantCommentaryText(commentaryMessage));
    appendRawStream({
      ts: Date.now(),
      event: "assistant_message_end",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      rawText: coerceChatContentText(extractEmbeddedAssistantText(assistantMessage)),
      rawThinking: extractAssistantThinking(assistantMessage),
    });
    const commentaryAlreadyStreamed =
      isResponsesCommentary &&
      Boolean(ctx.state.deltaBuffer) &&
      ctx.state.deltaBuffer === commentaryText;
    if (commentaryText && !commentaryAlreadyStreamed) {
      ctx.emitAssistantStreamData(
        buildAssistantStreamData({
          text: commentaryText,
          replace: true,
          phase: "commentary",
          itemId: isResponsesCommentary ? ctx.state.lastAssistantStreamItemId : undefined,
        }),
      );
    }
    // Commentary-tagged tool turns can still carry durable reasoning under /reasoning on.
    const suppressedTrimmedReasoning = ctx.state.includeReasoning
      ? extractAssistantThinking(assistantMessage).trim()
      : "";
    if (
      !ctx.params.silentExpected &&
      !suppressDeterministicApprovalOutput &&
      !suppressMessageToolOnlySourceReplyOutput &&
      ctx.state.includeReasoning &&
      suppressedTrimmedReasoning &&
      ctx.params.onBlockReply &&
      suppressedTrimmedReasoning !== ctx.state.lastReasoningSent
    ) {
      ctx.state.lastReasoningSent = suppressedTrimmedReasoning;
      ctx.emitBlockReply({ text: suppressedTrimmedReasoning, isReasoning: true });
    }
    return;
  }
  promoteThinkingTagsToBlocks(assistantMessage);

  const rawText = coerceChatContentText(extractEmbeddedAssistantText(assistantMessage));
  const rawVisibleText = coerceChatContentText(extractAssistantVisibleText(assistantMessage));
  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    rawText,
    rawThinking: extractAssistantThinking(assistantMessage),
  });
  warnIfAssistantEmittedSuspiciousText(ctx, assistantMessage);
  const visibleText =
    extractStandaloneMessageToolText(rawVisibleText, {
      allowRoutedReply: isOpenAiCompletionsAssistantMessage(assistantMessage),
      allowCurrentSourceReply:
        ctx.params.sourceReplyDeliveryMode === "message_tool_only" &&
        ctx.builtinToolNames?.has("message") === true,
    }) ?? rawVisibleText;
  const finalVisibleText = ctx.params.enforceFinalTag
    ? ctx.stripBlockTags(visibleText, { thinking: false, final: false }, { final: true })
    : visibleText;

  // Exact NO_REPLY stays silent. The legacy rewrite (silentReplyRewrite) was
  // removed by contract; global messaging-tool send evidence is not a
  // user-route reply and must never be mirrored into the final payload.
  const text = finalVisibleText;
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const trimmedReasoning = rawThinking ? rawThinking.trim() : "";
  const trimmedText = text.trim();
  const parsedText = trimmedText ? parseReplyDirectives(trimmedText) : null;
  const cleanedText = parsedText?.text ?? "";
  const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedText ?? {});

  const finalizeMessageEnd = () => {
    ctx.state.deltaBuffer = "";
    ctx.state.thinkingTagStream = createThinkingTagStreamState();
    ctx.state.deltaBufferIsCommentary = false;
    ctx.state.hasFlushedPartialText = false;
    ctx.state.blockBuffer = "";
    ctx.blockChunker?.reset();
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();
    ctx.state.blockState.fence = undefined;
    ctx.state.blockState.reasoningInlineCode = undefined;
    ctx.state.blockState.reasoningFence = undefined;
    ctx.state.blockState.reasoningPendingFenceFragment = undefined;
    ctx.state.blockState.finalInlineCode = undefined;
    ctx.state.blockState.finalFence = undefined;
    ctx.state.blockState.pendingFenceFragment = undefined;
    ctx.state.blockState.pendingTagFragment = undefined;
    ctx.state.partialBlockState.fence = undefined;
    ctx.state.partialBlockState.reasoningInlineCode = undefined;
    ctx.state.partialBlockState.reasoningFence = undefined;
    ctx.state.partialBlockState.reasoningPendingFenceFragment = undefined;
    ctx.state.partialBlockState.finalInlineCode = undefined;
    ctx.state.partialBlockState.finalFence = undefined;
    ctx.state.partialBlockState.pendingFenceFragment = undefined;
    ctx.state.partialBlockState.pendingTagFragment = undefined;
    ctx.state.lastStreamedAssistant = undefined;
    ctx.state.lastStreamedAssistantCleaned = undefined;
    ctx.state.reasoningStreamOpen = false;
  };

  const previousStreamedText = ctx.state.lastStreamedAssistantCleaned ?? "";
  const shouldReplaceFinalStream = Boolean(
    previousStreamedText && cleanedText && !cleanedText.startsWith(previousStreamedText),
  );
  const didTextChangeWithinCurrentMessage = Boolean(
    previousStreamedText && cleanedText !== previousStreamedText,
  );
  const finalStreamDelta = shouldReplaceFinalStream
    ? ""
    : cleanedText.slice(previousStreamedText.length);

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    (cleanedText || hasMedia) &&
    (!ctx.state.emittedAssistantUpdate ||
      shouldReplaceFinalStream ||
      didTextChangeWithinCurrentMessage ||
      hasMedia)
  ) {
    const data = buildAssistantStreamData({
      text: cleanedText,
      delta: finalStreamDelta,
      replace: shouldReplaceFinalStream,
      mediaUrls,
      phase: assistantPhase,
    });
    ctx.emitAssistantStreamData(data);
    ctx.state.emittedAssistantUpdate = true;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;
  }

  const silentExpectedWithoutSentinel =
    ctx.params.silentExpected && !isSilentReplyText(trimmedText, SILENT_REPLY_TOKEN);
  const finalAssistantText = silentExpectedWithoutSentinel ? "" : text;
  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({
    text: finalAssistantText,
    addedDuringMessage,
    chunkerHasBuffered,
  });

  const onBlockReply = ctx.params.onBlockReply;
  const shouldEmitReasoning = Boolean(
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    ctx.state.includeReasoning &&
    trimmedReasoning &&
    onBlockReply &&
    trimmedReasoning !== ctx.state.lastReasoningSent,
  );
  const shouldEmitReasoningBeforeAnswer =
    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" && !addedDuringMessage;
  const maybeEmitReasoning = () => {
    if (!shouldEmitReasoning || !trimmedReasoning) {
      return;
    }
    ctx.state.lastReasoningSent = trimmedReasoning;
    // Lane purity: the payload carries raw thinking only. Tool persistence is
    // the verbose lane's job; interleaving comes from arrival order.
    ctx.emitBlockReply({ text: trimmedReasoning, isReasoning: true });
  };

  if (shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }

  const emitSplitResultAsBlockReply = (
    splitResult: ReturnType<typeof ctx.consumeReplyDirectives> | null | undefined,
  ) => {
    if (!splitResult || !onBlockReply) {
      return;
    }
    const {
      text: cleanedTextLocal,
      mediaUrls: mediaUrlsLocal,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    // Emit if there's content OR audioAsVoice flag (to propagate the flag).
    if (
      hasAssistantVisibleReply({ text: cleanedTextLocal, mediaUrls: mediaUrlsLocal, audioAsVoice })
    ) {
      ctx.emitBlockReply(
        {
          text: cleanedTextLocal,
          mediaUrls: mediaUrlsLocal?.length ? mediaUrlsLocal : undefined,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        },
        { assistantMessageIndex: ctx.state.assistantMessageIndex },
      );
    }
  };

  const consumeFinalReplyDirectives = () => {
    const bufferedResult = ctx.consumeReplyDirectives("", { final: true });
    if (!hasMedia || !parsedText) {
      return bufferedResult;
    }
    const bufferedRawText = bufferedResult?.text ?? "";
    const leadingWhitespace = bufferedRawText.match(/^\s+/u)?.[0] ?? "";
    const strippedBufferedText = bufferedRawText ? splitMediaFromOutput(bufferedRawText).text : "";
    const bufferedText =
      leadingWhitespace &&
      strippedBufferedText &&
      !strippedBufferedText.startsWith(leadingWhitespace)
        ? `${leadingWhitespace}${strippedBufferedText}`
        : strippedBufferedText;
    return {
      ...bufferedResult,
      ...parsedText,
      text: bufferedText,
    };
  };

  const hasBufferedBlockReply = ctx.blockChunker
    ? ctx.blockChunker.hasBuffered()
    : ctx.state.blockBuffer.length > 0;

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    text &&
    onBlockReply &&
    (ctx.state.blockReplyBreak === "message_end" ||
      hasBufferedBlockReply ||
      text !== ctx.state.lastBlockReplyText ||
      hasMedia)
  ) {
    if (hasBufferedBlockReply && ctx.blockChunker?.hasBuffered()) {
      const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({
        assistantMessageIndex: ctx.state.assistantMessageIndex,
        final: true,
      });
      if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
        void flushBlockReplyBufferResult.catch((err: unknown) => {
          ctx.log.debug(`message_end block reply flush failed: ${String(err)}`);
        });
      }
      // Final-flush the streaming directive accumulator so any partial
      // inline reply/audio tag held back by splitTrailingDirective gets
      // emitted on the message_end / blockReplyChunking path.
      emitSplitResultAsBlockReply(consumeFinalReplyDirectives());
    } else if (text !== ctx.state.lastBlockReplyText || hasMedia) {
      // Guard: for text_end channels, if text_end already delivered content
      // (lastBlockReplyText is set), skip this safety send. The text comparison
      // here uses a different stripping pipeline (stripBlockTags with reset state)
      // than emitBlockChunk (stripBlockTags with running blockState +
      // stripDowngradedToolCallText), which can false-positive. When text_end
      // didn't deliver (e.g. commentary suppressed, provider skipped text_end),
      // lastBlockReplyText is still null and message_end must deliver.
      if (
        ctx.state.blockReplyBreak === "text_end" &&
        ctx.state.lastBlockReplyText != null &&
        !hasMedia
      ) {
        ctx.log.debug(
          `Skipping message_end safety send for text_end channel - content already delivered via text_end`,
        );
      } else {
        // Check for duplicates before emitting (same logic as emitBlockChunk).
        const normalizedText = normalizeTextForComparison(hasMedia ? cleanedText : text);
        if (
          isMessagingToolDuplicateNormalized(
            normalizedText,
            ctx.state.messagingToolSentTextsNormalized,
          )
        ) {
          ctx.log.debug(
            `Skipping message_end block reply - already sent via messaging tool: ${truncateUtf16Safe(text, 50)}...`,
          );
        } else {
          const alreadyDeliveredFinalText = Boolean(
            hasMedia && cleanedText && cleanedText === ctx.state.lastBlockReplyText,
          );
          ctx.state.lastBlockReplyText = hasMedia ? cleanedText || text : text;
          ctx.state.lastDeliveredBlockReplyText = hasMedia ? cleanedText || text : text;
          ctx.state.toolExecutionSinceLastBlockReply = false;
          emitSplitResultAsBlockReply(
            hasMedia && parsedText
              ? {
                  ...parsedText,
                  text: alreadyDeliveredFinalText ? "" : cleanedText,
                }
              : ctx.consumeReplyDirectives(text, { final: true }),
          );
        }
      }
    }
  }

  if (!shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }
  if (!ctx.params.silentExpected && rawThinking) {
    // Emit-always: bus/archive get message-end thinking regardless of the
    // streamReasoning rendering setting (gated inside emitReasoningStream).
    ctx.emitReasoningStream(rawThinking);
  }

  if (
    !ctx.params.silentExpected &&
    !suppressMessageToolOnlySourceReplyOutput &&
    ctx.state.blockReplyBreak === "text_end" &&
    onBlockReply
  ) {
    emitSplitResultAsBlockReply(ctx.consumeReplyDirectives("", { final: true }));
  }

  if (
    !ctx.params.silentExpected &&
    ctx.state.blockReplyBreak === "message_end" &&
    ctx.params.onBlockReplyFlush
  ) {
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
      return flushBlockReplyBufferResult
        .then(() => {
          const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({
            reason: "message_end",
          });
          if (isPromiseLike<void>(onBlockReplyFlushResult)) {
            return onBlockReplyFlushResult;
          }
          return undefined;
        })
        .finally(() => {
          finalizeMessageEnd();
        });
    }
    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush({ reason: "message_end" });
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult.finally(() => {
        finalizeMessageEnd();
      });
    }
  }

  finalizeMessageEnd();
  return undefined;
}
