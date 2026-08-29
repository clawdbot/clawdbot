import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
/**
 * Handles assistant message lifecycle boundaries, final reconciliation, and usage.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
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
import {
  emitResolvedCommentaryDisplay,
  resolveCommentaryDisplayText,
} from "./embedded-agent-subscribe.handlers.messages.continuation.js";
import {
  preservePendingAssistantUsage,
  resetMessageEndStreamingState,
  shouldSuppressValidationLoopAssistantOutput,
} from "./embedded-agent-subscribe.handlers.messages.lifecycle-state.js";
import {
  hasAssistantVisibleReply,
  hasReplyDirectiveMetadataResult,
  hasReplyTargetOnlyTerminalEvidence,
  resolveManagedStreamMediaUrls,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  buildAssistantStreamData,
  emitAssistantMessageStart,
  emitReasoningEnd,
  extractStandaloneMessageToolText,
  hasMessageToolOnlySourceDelivery,
  isAnthropicAssistantMessage,
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
  extractAssistantCommentaryText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  extractEmbeddedAssistantText,
  extractThinkingFromTaggedText,
  promoteThinkingTagsToBlocks,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";
import { summarizeToolValidationError } from "./tool-error-summary.js";

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
  options?: { deliveryGeneration?: number },
): void | Promise<void> {
  if (
    options?.deliveryGeneration !== undefined &&
    options.deliveryGeneration !== ctx.getBlockReplyDeliveryGeneration()
  ) {
    return;
  }
  const isCurrentDeliveryGeneration = () =>
    options?.deliveryGeneration === undefined ||
    options.deliveryGeneration === ctx.getBlockReplyDeliveryGeneration();
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }
  const preflightBlockReplyResult = ctx.settleBlockReplyDeliveries?.({
    retryFailures: true,
  });
  if (isPromiseLike<void>(preflightBlockReplyResult)) {
    return Promise.resolve(preflightBlockReplyResult).then(() =>
      handleMessageEnd(ctx, evt, options),
    );
  }
  const hasTextEndBufferedBlockReply =
    ctx.state.blockReplyBreak === "text_end" &&
    ((ctx.blockChunker?.hasBuffered() ?? false) || ctx.state.blockBuffer.length > 0);
  if (hasTextEndBufferedBlockReply) {
    const flushTextEndBufferResult = ctx.flushBlockReplyBuffer({
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      final: true,
    });
    if (isPromiseLike<void>(flushTextEndBufferResult)) {
      return Promise.resolve(flushTextEndBufferResult).then(() =>
        handleMessageEnd(ctx, evt, options),
      );
    }
  }

  // Transcript-only messages never reach the provider, so this counts exactly
  // the completed model round trips consumers see as `assistantTurns`.
  ctx.state.assistantTurnCount += 1;
  const assistantMessage = preservePendingAssistantUsage(msg, ctx.state.pendingAssistantUsage);
  const assistantPhase = resolveAssistantMessagePhase(assistantMessage);
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(assistantMessage);
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);
  // Provider completion can omit thinking_end; close the visible lane before final output.
  if (!suppressMessageToolOnlySourceReplyOutput) {
    emitReasoningEnd(ctx);
  }
  ctx.noteLastAssistant(assistantMessage);
  ctx.noteCompletedAssistant(assistantMessage);
  ctx.recordAssistantUsage((assistantMessage as { usage?: unknown }).usage);
  ctx.commitAssistantUsage();
  if (suppressVisibleAssistantOutput) {
    const isResponsesCommentary = isResponsesApiAssistantMessage(assistantMessage);
    const shouldScopeCommentary =
      isResponsesCommentary || isAnthropicAssistantMessage(assistantMessage);
    const commentaryMessage = shouldScopeCommentary
      ? scopeAssistantMessageToStreamBlock(
          assistantMessage as AssistantMessage,
          ctx.state.lastAssistantStreamContentIndex,
          ctx.state.lastAssistantStreamItemId,
        )
      : assistantMessage;
    const rawCommentaryText = coerceChatContentText(
      extractAssistantCommentaryText(commentaryMessage),
    );
    appendRawStream({
      ts: Date.now(),
      event: "assistant_message_end",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      rawText: coerceChatContentText(extractEmbeddedAssistantText(assistantMessage)),
      rawThinking: extractAssistantThinking(assistantMessage),
    });
    emitResolvedCommentaryDisplay(ctx, rawCommentaryText, {
      final: true,
      itemId: ctx.state.lastAssistantStreamItemId,
      preferReplace: !ctx.state.commentaryStreamedWithDelta,
    });
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
  const validationErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;
  if (
    shouldSuppressValidationLoopAssistantOutput({
      message: assistantMessage,
      validationErrorSummary,
      text: rawText,
    })
  ) {
    resetMessageEndStreamingState(ctx);
    return;
  }
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
  let replyTargetOnlyTerminalEvidence = false;
  const parsedText = (() => {
    if (!trimmedText) {
      return null;
    }
    const parsed = parseReplyDirectives(trimmedText);
    replyTargetOnlyTerminalEvidence = hasReplyTargetOnlyTerminalEvidence(parsed);
    const displayText = resolveCommentaryDisplayText(parsed.text, { final: true });
    return displayText === parsed.text ? parsed : { ...parsed, text: displayText };
  })();
  const cleanedText = parsedText?.text ?? "";
  const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedText ?? {});
  const managedMediaUrls = resolveManagedStreamMediaUrls(ctx.state, mediaUrls);

  const finalizeMessageEnd = () => {
    resetMessageEndStreamingState(ctx);
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
      managedMediaUrls,
      phase: assistantPhase,
    });
    ctx.emitAssistantStreamData(data);
    ctx.state.emittedAssistantUpdate = true;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;
  }

  const silentExpectedWithoutSentinel =
    ctx.params.silentExpected && !isSilentReplyText(trimmedText, SILENT_REPLY_TOKEN);
  const finalAssistantText = silentExpectedWithoutSentinel ? "" : cleanedText;
  const terminalAssistantTextEvidence =
    replyTargetOnlyTerminalEvidence || parsedText?.isSilent ? trimmedText : finalAssistantText;
  const deliveredBlockReplyTexts = ctx.state.deliveredBlockReplyTexts.filter(Boolean);
  const attemptedBlockReplyTexts = (ctx.state.attemptedBlockReplyTexts ?? []).filter(Boolean);
  const effectiveDeliveredBlockReplyTexts =
    attemptedBlockReplyTexts.length > 0
      ? attemptedBlockReplyTexts
      : deliveredBlockReplyTexts.length > 0
        ? deliveredBlockReplyTexts
        : ctx.state.deferredBlockReplyTexts;
  const deliveredCanonicalPrefix = (() => {
    if (!finalAssistantText || effectiveDeliveredBlockReplyTexts.length === 0) {
      return undefined;
    }
    let cursor = 0;
    for (const deliveredText of effectiveDeliveredBlockReplyTexts) {
      const matchIndex = finalAssistantText.indexOf(deliveredText, cursor);
      if (matchIndex < 0 || finalAssistantText.slice(cursor, matchIndex).trim().length > 0) {
        return undefined;
      }
      cursor = matchIndex + deliveredText.length;
    }
    return finalAssistantText.slice(0, cursor);
  })();
  const textEndDeliveredText =
    deliveredCanonicalPrefix ?? (effectiveDeliveredBlockReplyTexts.join("\n") || undefined);
  const textEndDeliveredVisibleText =
    textEndDeliveredText != null
      ? resolveCommentaryDisplayText(textEndDeliveredText, {
          final: true,
        })
      : undefined;
  const finalTextMatchesDelivered =
    textEndDeliveredVisibleText != null &&
    normalizeTextForComparison(finalAssistantText) ===
      normalizeTextForComparison(textEndDeliveredVisibleText);
  const finalTextCorrection = finalTextMatchesDelivered
    ? ""
    : textEndDeliveredVisibleText && finalAssistantText.startsWith(textEndDeliveredVisibleText)
      ? finalAssistantText.slice(textEndDeliveredVisibleText.length)
      : finalAssistantText !== textEndDeliveredVisibleText
        ? finalAssistantText
        : "";
  const resolveUndeliveredFinalDirectives = () => {
    const deliveredReplyDirectives = ctx.state.lastDeliveredAssistantReplyDirectives;
    const deferredReplyDirectives = ctx.state.deferredAssistantReplyDirectives;
    const undeliveredMediaUrls = mediaUrls.filter(
      (url) =>
        !deliveredReplyDirectives?.mediaUrls?.includes(url) &&
        !deferredReplyDirectives?.mediaUrls?.includes(url),
    );
    const undeliveredAudioAsVoice = Boolean(
      parsedText?.audioAsVoice &&
      !deliveredReplyDirectives?.audioAsVoice &&
      !deferredReplyDirectives?.audioAsVoice,
    );
    const hasUndeliveredReplyToId = Boolean(
      parsedText?.replyToId &&
      parsedText.replyToId !== deliveredReplyDirectives?.replyToId &&
      parsedText.replyToId !== deferredReplyDirectives?.replyToId,
    );
    const hasUndeliveredReplyToTag = Boolean(
      parsedText?.replyToTag &&
      !deliveredReplyDirectives?.replyToTag &&
      !deferredReplyDirectives?.replyToTag,
    );
    const hasUndeliveredReplyToCurrent = Boolean(
      parsedText?.replyToCurrent &&
      !deliveredReplyDirectives?.replyToCurrent &&
      !deferredReplyDirectives?.replyToCurrent,
    );
    const hasUndeliveredReplyTarget =
      hasUndeliveredReplyToId || hasUndeliveredReplyToTag || hasUndeliveredReplyToCurrent;
    const hasMetadata =
      undeliveredMediaUrls.length > 0 || undeliveredAudioAsVoice || hasUndeliveredReplyTarget;
    const result = parsedText
      ? {
          ...parsedText,
          mediaUrls: undeliveredMediaUrls.length ? undeliveredMediaUrls : undefined,
          audioAsVoice: undeliveredAudioAsVoice || undefined,
          replyToId: hasUndeliveredReplyToId ? parsedText.replyToId : undefined,
          replyToTag: hasUndeliveredReplyToTag,
          replyToCurrent: hasUndeliveredReplyToCurrent || undefined,
        }
      : null;
    return {
      result,
      mediaUrls: undeliveredMediaUrls,
      audioAsVoice: undeliveredAudioAsVoice,
      hasReplyTarget: hasUndeliveredReplyTarget,
      hasMetadata,
    };
  };
  const finalDirectives = resolveUndeliveredFinalDirectives();
  const hasFinalAssistantReply = hasAssistantVisibleReply({
    text: finalAssistantText,
    mediaUrls,
    audioAsVoice: parsedText?.audioAsVoice,
  });
  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const currentMessageAssistantText = ctx.state.assistantTexts
    .slice(ctx.state.assistantTextBaseline)
    .join("\n");
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({
    text: terminalAssistantTextEvidence,
    addedDuringMessage,
    chunkerHasBuffered,
    reconcileCurrentMessage:
      ctx.state.blockReplyBreak === "text_end" &&
      addedDuringMessage &&
      !replyTargetOnlyTerminalEvidence &&
      finalAssistantText !== currentMessageAssistantText,
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
    onDelivered?: () => void,
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
    const displayTextLocal = resolveCommentaryDisplayText(cleanedTextLocal, { final: true });
    // Emit if there's content OR audioAsVoice flag (to propagate the flag).
    if (
      hasAssistantVisibleReply({ text: displayTextLocal, mediaUrls: mediaUrlsLocal, audioAsVoice })
    ) {
      ctx.emitBlockReply(
        {
          text: displayTextLocal,
          mediaUrls: mediaUrlsLocal?.length ? mediaUrlsLocal : undefined,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        },
        {
          assistantMessageIndex: ctx.state.assistantMessageIndex,
          onDelivered,
        },
      );
    }
  };

  const finishMessageEndDelivery = (): void | Promise<void> => {
    if (!isCurrentDeliveryGeneration()) {
      return;
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
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
            const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({
              reason: "message_end",
            });
            if (isPromiseLike<void>(onBlockReplyFlushResult)) {
              return onBlockReplyFlushResult;
            }
            return undefined;
          })
          .finally(() => {
            if (isCurrentDeliveryGeneration()) {
              finalizeMessageEnd();
            }
          });
      }
      const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush({ reason: "message_end" });
      if (isPromiseLike<void>(onBlockReplyFlushResult)) {
        return onBlockReplyFlushResult.finally(() => {
          if (isCurrentDeliveryGeneration()) {
            finalizeMessageEnd();
          }
        });
      }
    }

    finalizeMessageEnd();
    return undefined;
  };

  // The accumulator must always be final-flushed so an incomplete bracket tail held
  // back by splitTrailingDirective is released, while still emitting undelivered
  // continuation metadata (media/audio/reply target) exactly once.
  const composeFinalBlockReply = (
    bufferedResult: ReturnType<typeof ctx.consumeReplyDirectives>,
  ) => {
    const remainingFinalDirectives = resolveUndeliveredFinalDirectives();
    if (!remainingFinalDirectives.hasMetadata || !remainingFinalDirectives.result) {
      return bufferedResult;
    }
    return {
      ...remainingFinalDirectives.result,
      text:
        remainingFinalDirectives.hasReplyTarget &&
        remainingFinalDirectives.mediaUrls.length === 0 &&
        !remainingFinalDirectives.audioAsVoice
          ? finalAssistantText
          : (bufferedResult?.text ?? ""),
    };
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
    return bufferedResult
      ? {
          ...bufferedResult,
          text: bufferedText,
        }
      : {
          text: bufferedText,
          replyToTag: false,
          isSilent: false,
        };
  };

  const hasBufferedBlockReply = ctx.blockChunker
    ? ctx.blockChunker.hasBuffered()
    : ctx.state.blockBuffer.length > 0;

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    hasFinalAssistantReply &&
    onBlockReply &&
    (hasBufferedBlockReply ||
      finalAssistantText !== textEndDeliveredVisibleText ||
      finalDirectives.hasMetadata)
  ) {
    if (hasBufferedBlockReply && ctx.blockChunker?.hasBuffered()) {
      const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({
        assistantMessageIndex: ctx.state.assistantMessageIndex,
        final: true,
      });
      if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
        return Promise.resolve(flushBlockReplyBufferResult).then(
          () => {
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
            emitSplitResultAsBlockReply(composeFinalBlockReply(consumeFinalReplyDirectives()));
            return finishMessageEndDelivery();
          },
          (err: unknown) => {
            ctx.log.debug(`message_end block reply flush failed: ${String(err)}`);
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
            return finishMessageEndDelivery();
          },
        );
      }
      // Final-flush the streaming directive accumulator so any partial
      // inline reply/audio tag held back by splitTrailingDirective gets
      // emitted on the message_end / blockReplyChunking path.
      emitSplitResultAsBlockReply(composeFinalBlockReply(consumeFinalReplyDirectives()));
    } else if (finalAssistantText !== textEndDeliveredVisibleText || finalDirectives.hasMetadata) {
      // Skip only an unchanged text_end delivery. Canonical message_end text
      // can extend or replace the streamed snapshot, and final-only directive
      // metadata can still require a second delivery.
      if (
        ctx.state.blockReplyBreak === "text_end" &&
        ctx.state.lastBlockReplyText != null &&
        !finalTextCorrection &&
        !finalDirectives.hasMetadata
      ) {
        ctx.log.debug(
          `Skipping message_end safety send for text_end channel - content already delivered via text_end`,
        );
      } else {
        // Check for duplicates before emitting (same logic as emitBlockChunk).
        const normalizedText = normalizeTextForComparison(finalTextCorrection || cleanedText);
        if (
          isMessagingToolDuplicateNormalized(
            normalizedText,
            ctx.state.messagingToolSentTextsNormalized,
          )
        ) {
          ctx.log.debug(
            `Skipping message_end block reply - already sent via messaging tool: ${truncateUtf16Safe(finalAssistantText, 50)}...`,
          );
        } else {
          const metadataOnlyText =
            finalDirectives.hasReplyTarget &&
            finalDirectives.mediaUrls.length === 0 &&
            !finalDirectives.audioAsVoice
              ? finalAssistantText
              : "";
          const correctionPayload = hasReplyDirectiveMetadataResult(finalDirectives.result)
            ? {
                ...finalDirectives.result,
                text: finalTextCorrection || metadataOnlyText,
              }
            : textEndDeliveredText != null
              ? {
                  ...parseReplyDirectives(finalAssistantText),
                  text: finalTextCorrection,
                }
              : (consumeFinalReplyDirectives() ??
                ctx.consumeReplyDirectives(finalAssistantText, { final: true }));
          // A correction is canonical text minus what text_end delivered, so it
          // already carries the tail splitTrailingDirective is still holding.
          // Drain that residue here or finishMessageEndDelivery releases it a
          // second time and the channel sees the tail twice.
          if (finalTextCorrection) {
            ctx.consumeReplyDirectives("", { final: true });
          }
          ctx.state.lastBlockReplyText = finalAssistantText;
          ctx.state.toolExecutionSinceLastBlockReply = false;
          emitSplitResultAsBlockReply(correctionPayload, () => {
            ctx.state.lastDeliveredBlockReplyText = finalAssistantText;
            if (finalAssistantText) {
              ctx.state.deliveredBlockReplyTexts = [finalAssistantText];
              ctx.state.attemptedBlockReplyTexts = [finalAssistantText];
            }
          });
        }
      }
    }
  }
  return finishMessageEndDelivery();
}
