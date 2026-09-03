import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
/**
 * Handles assistant message lifecycle boundaries, and final reconciliation.
 */
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers.js";
import { resolveFinalReplyReconciliation } from "./embedded-agent-subscribe.handlers.messages.final-reconciliation.js";
import {
  resetMessageEndStreamingState,
  shouldSuppressValidationLoopAssistantOutput,
} from "./embedded-agent-subscribe.handlers.messages.lifecycle-state.js";
import {
  hasAssistantVisibleReply,
  hasReplyTargetOnlyTerminalEvidence,
  resolveManagedStreamMediaUrls,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  emitAssistantCommentaryStreamData,
  emitAssistantMessageStart,
  emitReasoningEnd,
  extractAssistantStreamSnapshot,
  extractStandaloneMessageToolText,
  hasMessageToolOnlySourceDelivery,
  isOpenAiCompletionsAssistantMessage,
  isResponsesApiAssistantMessage,
  isSubscribeTranscriptOnlyOpenClawAssistantMessage,
  replaceBlockReplyBuffer,
  scopeAssistantMessageToStreamBlock,
  shouldSuppressDeterministicApprovalOutput,
  stripContinuationSignalFromDisplayText,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";
import { warnIfAssistantEmittedSuspiciousText } from "./embedded-agent-subscribe.tool-text-diagnostics.js";
import {
  createThinkingTagStreamState,
  extractAssistantThinking,
  extractEmbeddedAssistantText,
  extractThinkingFromTaggedText,
  promoteThinkingTagsToBlocks,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";
import { summarizeToolValidationError } from "./tool-error-summary.js";

const resolveCommentaryDisplayText = (text: string, _options?: { final?: boolean }) =>
  stripContinuationSignalFromDisplayText(text);
export function handleMessageStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  // Only message_start opens another message's stream and block replies.
  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
  ctx.state.assistantMessageStartIndex = ctx.state.assistantMessageIndex;
  // Use assistant message_start as the earliest "writing" signal for typing.
  emitAssistantMessageStart(ctx);
}

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

  // Transcript-only messages never reach the provider, so this counts exactly
  // the completed model round trips consumers see as `assistantTurns`.
  ctx.state.assistantTurnCount += 1;
  const assistantMessage = msg;
  const assistantPhase = resolveAssistantMessagePhase(assistantMessage);
  const suppressVisibleAssistantOutput = assistantPhase === "commentary";
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);
  // Provider completion can omit thinking_end; close the visible lane before final output.
  if (!suppressMessageToolOnlySourceReplyOutput) {
    emitReasoningEnd(ctx);
  }
  ctx.noteLastAssistant(assistantMessage);
  if (suppressVisibleAssistantOutput) {
    appendRawStream(() => ({
      ts: Date.now(),
      event: "assistant_message_end",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      rawText: coerceChatContentText(extractEmbeddedAssistantText(assistantMessage)),
      rawThinking: extractAssistantThinking(assistantMessage),
    }));
    emitAssistantCommentaryStreamData(ctx, assistantMessage, true);
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
  const sourceContent = assistantMessage.content;
  promoteThinkingTagsToBlocks(assistantMessage);

  let rawText: string | undefined;
  const getRawText = () =>
    (rawText ??= coerceChatContentText(extractEmbeddedAssistantText(assistantMessage)));
  const snapshot = extractAssistantStreamSnapshot(ctx, assistantMessage);
  const rawVisibleText = snapshot.text;
  const validationErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;
  if (
    shouldSuppressValidationLoopAssistantOutput({
      message: assistantMessage,
      validationErrorSummary,
      text: getRawText(),
    })
  ) {
    resetMessageEndStreamingState(ctx);
    return;
  }
  appendRawStream(() => ({
    ts: Date.now(),
    event: "assistant_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    rawText: getRawText(),
    rawThinking: extractAssistantThinking(assistantMessage),
  }));
  warnIfAssistantEmittedSuspiciousText(ctx, assistantMessage);
  const text =
    extractStandaloneMessageToolText(rawVisibleText, {
      allowRoutedReply: isOpenAiCompletionsAssistantMessage(assistantMessage),
      allowCurrentSourceReply:
        ctx.params.sourceReplyDeliveryMode === "message_tool_only" &&
        ctx.builtinToolNames?.has("message") === true,
    }) ?? rawVisibleText;
  // Exact NO_REPLY stays silent. The legacy rewrite (silentReplyRewrite) was
  // removed by contract; global messaging-tool send evidence is not a
  // user-route reply and must never be mirrored into the final payload.
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(getRawText())
      : "";
  const trimmedReasoning = rawThinking ? rawThinking.trim() : "";
  const trimmedText = text.trim();
  ctx.resetPartialReplyDirectives();
  const parsedRawText = parseReplyDirectives(trimmedText);
  const replyTargetOnlyTerminalEvidence = hasReplyTargetOnlyTerminalEvidence(parsedRawText);
  const displayText = stripContinuationSignalFromDisplayText(parsedRawText.text);
  const parsedText =
    displayText === parsedRawText.text ? parsedRawText : { ...parsedRawText, text: displayText };
  const cleanedText = parsedText.text;
  const { mediaUrls } = resolveSendableOutboundReplyParts(parsedText, { text: "" });
  const managedMediaUrls = resolveManagedStreamMediaUrls(ctx.state, mediaUrls);

  const sourceMessage = { ...assistantMessage, content: sourceContent };
  const sourceSnapshot =
    sourceContent === assistantMessage.content
      ? snapshot
      : extractAssistantStreamSnapshot(ctx, sourceMessage);
  const hadBlockReplyBeforeMessageEnd =
    (ctx.state.attemptedBlockReplyTexts?.length ?? 0) > 0 ||
    ctx.state.deliveredBlockReplyTexts.length > 0;
  const hasMultiplePhasedTextItems =
    Array.isArray(sourceContent) &&
    sourceContent.filter(
      (block) =>
        block.type === "text" && parseAssistantTextSignature(block)?.phase === "final_answer",
    ).length > 1;
  const resolveSourceIndex = (contentIndex: number | undefined, itemId: string | undefined) =>
    contentIndex ??
    (Array.isArray(sourceContent) && itemId
      ? sourceContent.findIndex(
          (block) => block.type === "text" && parseAssistantTextSignature(block)?.id === itemId,
        )
      : -1);
  const lastIndex = resolveSourceIndex(
    ctx.state.lastAssistantStreamContentIndex,
    ctx.state.lastAssistantStreamItemId,
  );
  const preparedSourceText = (index: number) =>
    parseReplyDirectives(
      extractAssistantStreamSnapshot(
        ctx,
        scopeAssistantMessageToStreamBlock(sourceMessage, index, undefined),
      ).text.trim(),
    ).text;
  const preparedMessageEndParts = sourceSnapshot.parts.map((part) =>
    preparedSourceText(part.index ?? 0).trim(),
  );
  const deliverMessageEndPartsIndividually =
    ctx.state.lastBlockReplyText == null &&
    sourceSnapshot.parts.length > 1 &&
    !isResponsesApiAssistantMessage(assistantMessage) &&
    !hasMultiplePhasedTextItems &&
    Boolean(sourceSnapshot.text.trim()) &&
    normalizeTextForComparison(preparedMessageEndParts.join(" ")) ===
      normalizeTextForComparison(sourceSnapshot.text) &&
    ctx.params.onBlockReply != null;
  // Draining hidden reasoning or NO_REPLY consumes source without preparing a
  // visible reply. A final replacement must rebuild that logical reply in full.
  if (ctx.state.lastBlockReplyText == null) {
    ctx.blockChunker.reset();
  }
  if (text !== rawVisibleText) {
    // A structured message-tool result is projected before it enters the reply buffer.
    ctx.state.blockState.textIsVisible = true;
    replaceBlockReplyBuffer(ctx, text);
  } else if (ctx.blockChunker.consumedLength === 0) {
    // Observing a native index does not mean its predecessors were delivered:
    // phase-pending and suppressed streams can leave the whole message unsent.
    const preparedIndex =
      ctx.state.lastAssistantTextMessageIndex >= ctx.state.assistantMessageStartIndex
        ? resolveSourceIndex(
            ctx.state.lastAssistantTextContentIndex,
            ctx.state.lastAssistantTextItemId,
          )
        : -1;
    const pendingText =
      preparedIndex >= 0 && Array.isArray(sourceContent)
        ? extractAssistantStreamSnapshot(ctx, {
            ...sourceMessage,
            content: sourceContent.slice(preparedIndex + 1),
          }).text
        : sourceSnapshot.text;
    ctx.state.blockState = {
      thinking: false,
      final: false,
      inlineCode: createInlineCodeState(),
      textIsVisible: true,
    };
    replaceBlockReplyBuffer(ctx, pendingText);
  } else if (lastIndex >= 0) {
    const currentPart = sourceSnapshot.parts.find((part) => part.index === lastIndex);
    const currentText = ctx.state.blockState.textIsVisible
      ? preparedSourceText(lastIndex)
      : (currentPart?.text ?? "");
    replaceBlockReplyBuffer(ctx, currentText, ctx.state.streamBlockOffset);
    for (const part of sourceSnapshot.parts) {
      if ((part.index ?? 0) > lastIndex) {
        const partText = ctx.state.blockState.textIsVisible
          ? preparedSourceText(part.index ?? 0)
          : part.text;
        ctx.blockChunker.append(
          `${ctx.blockChunker.hasBuffered() ? part.separator : ""}${partText}`,
        );
        ctx.state.lastAssistantStreamContentIndex = part.index;
      }
    }
  } else {
    replaceBlockReplyBuffer(
      ctx,
      ctx.state.blockState.textIsVisible ? cleanedText : sourceSnapshot.rawText,
    );
  }
  if (deliverMessageEndPartsIndividually) {
    ctx.blockChunker.reset();
    for (const partText of preparedMessageEndParts) {
      if (partText) {
        ctx.emitBlockChunk(partText, {
          assistantMessageIndex: ctx.state.assistantMessageIndex,
        });
      }
    }
  }

  const finalizeMessageEnd = () => {
    const deliveredMessageParts = (ctx.state.attemptedBlockReplyTexts ?? []).filter(Boolean);
    const phasedMessageKeepsDeliveredParts =
      (isResponsesApiAssistantMessage(assistantMessage) || hasMultiplePhasedTextItems) &&
      hadBlockReplyBeforeMessageEnd;
    const unphasedMessageKeepsDeliveredParts =
      !isResponsesApiAssistantMessage(assistantMessage) &&
      !hasMultiplePhasedTextItems &&
      sourceSnapshot.parts.length > 1 &&
      deliveredMessageParts.every((part) => !/[<`]/u.test(part));
    if (
      deliveredMessageParts.length > 1 &&
      (phasedMessageKeepsDeliveredParts || unphasedMessageKeepsDeliveredParts)
    ) {
      const currentCount = ctx.state.assistantTexts.length - messageAssistantTextBaseline;
      ctx.state.assistantTexts.splice(
        messageAssistantTextBaseline,
        currentCount,
        ...deliveredMessageParts,
      );
    } else if (sourceSnapshot.parts.length <= 1) {
      const currentCount = ctx.state.assistantTexts.length - messageAssistantTextBaseline;
      const currentText = ctx.state.assistantTexts.slice(messageAssistantTextBaseline).join("\n");
      const previousText =
        messageAssistantTextBaseline > 0
          ? ctx.state.assistantTexts[messageAssistantTextBaseline - 1]
          : undefined;
      const repeatsPreviousMessage =
        currentCount === 0 &&
        previousText !== undefined &&
        normalizeTextForComparison(previousText) === normalizeTextForComparison(finalAssistantText);
      if (
        !repeatsPreviousMessage &&
        normalizeTextForComparison(currentText) !== normalizeTextForComparison(finalAssistantText)
      ) {
        ctx.state.assistantTexts.splice(
          messageAssistantTextBaseline,
          currentCount,
          ...(finalAssistantText ? [finalAssistantText] : []),
        );
      }
    }
    ctx.state.deltaBuffer = "";
    ctx.state.streamBlockText = "";
    ctx.state.streamBlockOffset = 0;
    ctx.state.thinkingTagStream = createThinkingTagStreamState();
    ctx.state.deltaBufferIsCommentary = false;
    ctx.state.hasFlushedPartialText = false;
    ctx.blockChunker.reset();
    ctx.state.blockState = { thinking: false, final: false, inlineCode: createInlineCodeState() };
    // Late text_end events still use the partial lane's tag/inline state.
    const { thinking, final, inlineCode } = ctx.state.partialBlockState;
    ctx.state.partialBlockState = { thinking, final, inlineCode };
    ctx.state.assistantStream = undefined;
    ctx.state.reasoningStreamOpen = false;
  };

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput
  ) {
    ctx.emitAssistantStreamData(
      {
        text: cleanedText,
        delta: "",
        mediaUrls: mediaUrls.length ? mediaUrls : undefined,
        managedMediaUrls: managedMediaUrls.length ? managedMediaUrls : undefined,
        phase: assistantPhase,
      },
      { finalMessage: true },
    );
  }

  const silentExpectedWithoutSentinel =
    ctx.params.silentExpected && !isSilentReplyText(trimmedText, SILENT_REPLY_TOKEN);
  const finalAssistantText = silentExpectedWithoutSentinel ? "" : cleanedText;
  const terminalAssistantTextEvidence =
    replyTargetOnlyTerminalEvidence || parsedText.isSilent ? trimmedText : finalAssistantText;
  const {
    finalDirectives,
    finalTextCorrection,
    hasFinalAssistantReply,
    textEndDeliveredText,
    textEndDeliveredVisibleText,
    usedDeliveredCanonicalSuffix,
  } = resolveFinalReplyReconciliation({
    state: ctx.state,
    finalAssistantText,
    mediaUrls,
    parsedText,
  });
  const messageAssistantTextBaseline = ctx.state.assistantTextBaseline;
  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const currentMessageAssistantText = ctx.state.assistantTexts
    .slice(ctx.state.assistantTextBaseline)
    .join("\n");
  const chunkerHasBuffered = Boolean(ctx.params.onBlockReply) && ctx.blockChunker.hasBuffered();
  ctx.finalizeAssistantTexts({
    text: terminalAssistantTextEvidence,
    addedDuringMessage,
    chunkerHasBuffered,
    reconcileCurrentMessage:
      ctx.state.blockReplyBreak === "text_end" &&
      addedDuringMessage &&
      !deliverMessageEndPartsIndividually &&
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
    emitOptions?: { trimLeadingWhitespace?: boolean },
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
    const displayTextRaw = resolveCommentaryDisplayText(cleanedTextLocal, { final: true });
    const displayTextLocal =
      emitOptions?.trimLeadingWhitespace === true && !displayTextRaw.trimStart().startsWith("[[")
        ? displayTextRaw.trimStart()
        : displayTextRaw;
    // Emit if there's content OR audioAsVoice flag (to propagate the flag).
    if (
      hasAssistantVisibleReply({
        text: displayTextLocal,
        mediaUrls: mediaUrlsLocal,
        audioAsVoice,
      }) ||
      ctx.state.pendingToolMediaUrls.length > 0
    ) {
      const deliveredTextSlot =
        displayTextLocal.length > 0 ? ctx.state.deliveredBlockReplyTexts.push("") - 1 : undefined;
      if (displayTextLocal && deliveredTextSlot !== undefined) {
        ctx.state.attemptedBlockReplyTexts?.splice(deliveredTextSlot, 0, displayTextLocal);
      }
      ctx.emitBlockReply(
        {
          text: displayTextLocal,
          mediaUrls: mediaUrlsLocal?.length ? mediaUrlsLocal : undefined,
          audioAsVoice: audioAsVoice ?? false,
          replyToId,
          replyToTag,
          replyToCurrent,
        },
        {
          assistantMessageIndex: ctx.state.assistantMessageIndex,
          onDelivered: () => {
            if (displayTextLocal && deliveredTextSlot !== undefined) {
              ctx.state.deliveredBlockReplyTexts[deliveredTextSlot] = displayTextLocal;
            }
            onDelivered?.();
          },
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
      emitSplitResultAsBlockReply(consumeFinalReplyDirectives(), undefined, {
        trimLeadingWhitespace: true,
      });
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

  const consumeFinalReplyDirectives = () => {
    const bufferedResult = ctx.consumeReplyDirectives("", { final: true });
    if (!bufferedResult) {
      return bufferedResult;
    }
    const bufferedRawText = bufferedResult?.text ?? "";
    const leadingWhitespace = bufferedRawText.match(/^\s+/u)?.[0] ?? "";
    const strippedBufferedText = bufferedRawText ? splitMediaFromOutput(bufferedRawText).text : "";
    const bufferedTextWithWhitespace =
      leadingWhitespace &&
      strippedBufferedText &&
      !strippedBufferedText.startsWith(leadingWhitespace)
        ? `${leadingWhitespace}${strippedBufferedText}`
        : strippedBufferedText;
    const bufferedText = bufferedTextWithWhitespace.trimStart().startsWith("[[")
      ? bufferedTextWithWhitespace
      : bufferedTextWithWhitespace.trimStart();
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

  const hasBufferedBlockReply = textEndDeliveredText == null && ctx.blockChunker.hasBuffered();
  const hasPendingToolMedia = ctx.state.pendingToolMediaUrls.length > 0;
  if (textEndDeliveredText != null && ctx.blockChunker.hasBuffered()) {
    // message_end rebuilt the canonical snapshot after text_end already
    // delivered a prefix. Reconcile from the delivery ledger instead of
    // replaying that reconstructed buffer.
    ctx.blockChunker.reset();
  }
  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    hasFinalAssistantReply &&
    onBlockReply &&
    (hasBufferedBlockReply ||
      finalAssistantText !== textEndDeliveredVisibleText ||
      finalDirectives.hasMetadata ||
      hasPendingToolMedia)
  ) {
    if (hasBufferedBlockReply && ctx.blockChunker.hasBuffered()) {
      const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({
        assistantMessageIndex: ctx.state.assistantMessageIndex,
        final: true,
        finalReply: finalDirectives.result,
      });
      if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
        return Promise.resolve(flushBlockReplyBufferResult).then(
          () => {
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
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
          const correctionPayload = finalDirectives.hasMetadata
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
          emitSplitResultAsBlockReply(
            correctionPayload,
            () => {
              ctx.state.lastDeliveredBlockReplyText = finalAssistantText;
            },
            {
              trimLeadingWhitespace:
                /^[\r\n]/u.test(finalTextCorrection) ||
                finalDirectives.hasReplyTarget ||
                usedDeliveredCanonicalSuffix,
            },
          );
        }
      }
    }
  }
  return finishMessageEndDelivery();
}
