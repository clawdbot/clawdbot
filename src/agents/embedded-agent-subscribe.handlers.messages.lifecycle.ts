import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
/**
 * Handles assistant message lifecycle boundaries, and final reconciliation.
 */
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import {
  recordPendingAssistantReplyDirectives,
  resolveManagedStreamMediaUrls,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  buildAssistantStreamData,
  emitAssistantCommentaryStreamData,
  emitAssistantMessageStart,
  emitReasoningEnd,
  extractAssistantStreamSnapshot,
  extractStandaloneMessageToolText,
  hasMessageToolOnlySourceDelivery,
  isOpenAiCompletionsAssistantMessage,
  isSubscribeTranscriptOnlyOpenClawAssistantMessage,
  replaceBlockReplyBuffer,
  scopeAssistantMessageToStreamBlock,
  shouldSuppressDeterministicApprovalOutput,
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
): void | Promise<void> {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
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
  const parsedText = parseReplyDirectives(trimmedText);
  // Final media is emitted after the buffered text drains, never on its first chunk.
  recordPendingAssistantReplyDirectives(ctx.state, parsedText);
  const cleanedText = parsedText.text;
  const { mediaUrls } = resolveSendableOutboundReplyParts(parsedText);
  const managedMediaUrls = resolveManagedStreamMediaUrls(ctx.state, mediaUrls);

  const sourceMessage = { ...assistantMessage, content: sourceContent };
  const sourceSnapshot =
    sourceContent === assistantMessage.content
      ? snapshot
      : extractAssistantStreamSnapshot(ctx, sourceMessage);
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

  const finalizeMessageEnd = () => {
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
    const data = buildAssistantStreamData({
      text: cleanedText,
      mediaUrls,
      managedMediaUrls,
      phase: assistantPhase,
    });
    ctx.emitAssistantStreamData(data, { finalMessage: true });
  }

  const silentExpectedWithoutSentinel =
    ctx.params.silentExpected && !isSilentReplyText(trimmedText, SILENT_REPLY_TOKEN);
  const finalAssistantText = silentExpectedWithoutSentinel ? "" : text;
  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = Boolean(ctx.params.onBlockReply) && ctx.blockChunker.hasBuffered();
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

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    onBlockReply
  ) {
    // Reconcile source first, then finalize the parser and attachment selection
    // together. Replaying provider events here would rotate logical-item state.
    const pending = ctx.flushBlockReplyBuffer({
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      final: true,
      finalReply: parsedText,
    });
    if (pending) {
      void pending.catch((err: unknown) => {
        ctx.log.debug(`message_end block reply flush failed: ${String(err)}`);
      });
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
