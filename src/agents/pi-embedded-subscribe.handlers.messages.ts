import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type {
  EmbeddedPiSubscribeContext,
  EmbeddedPiSubscribeState,
} from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
} from "./pi-embedded-utils.js";

const stripTrailingDirective = (text: string): string => {
  const openIndex = text.lastIndexOf("[[");
  if (openIndex < 0) {
    if (text.endsWith("[")) {
      return text.slice(0, -1);
    }
    return text;
  }
  const closeIndex = text.indexOf("]]", openIndex + 2);
  if (closeIndex >= 0) {
    return text;
  }
  return text.slice(0, openIndex);
};

function shouldSuppressAssistantVisibleOutput(message: AgentMessage | undefined): boolean {
  return resolveAssistantMessagePhase(message) === "commentary";
}

function isTranscriptOnlyOpenClawAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = normalizeOptionalString(message.provider) ?? "";
  const model = normalizeOptionalString(message.model) ?? "";
  return provider === "openclaw" && (model === "delivery-mirror" || model === "gateway-injected");
}

function resolveAssistantStreamItemId(params: {
  contentIndex?: unknown;
  message: AgentMessage | undefined;
}): string | undefined {
  const content = (params.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const contentIndex =
    typeof params.contentIndex === "number" &&
    Number.isInteger(params.contentIndex) &&
    params.contentIndex >= 0
      ? params.contentIndex
      : undefined;
  const candidateBlocks =
    contentIndex !== undefined ? [content[contentIndex]] : content.toReversed();
  for (const block of candidateBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (record.type !== "text") {
      continue;
    }
    const signature = parseAssistantTextSignature(record.textSignature);
    if (signature?.id) {
      return signature.id;
    }
  }
  return undefined;
}

function emitReasoningEnd(ctx: EmbeddedPiSubscribeContext) {
  if (!ctx.state.reasoningStreamOpen) {
    return;
  }
  ctx.state.reasoningStreamOpen = false;
  void ctx.params.onReasoningEnd?.();
}

function openReasoningStream(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.reasoningStreamOpen = true;
}

function shouldSuppressDeterministicApprovalOutput(
  state: Pick<
    EmbeddedPiSubscribeState,
    "deterministicApprovalPromptPending" | "deterministicApprovalPromptSent"
  >,
): boolean {
  return state.deterministicApprovalPromptPending || state.deterministicApprovalPromptSent;
}

function appendBlockReplyChunk(ctx: EmbeddedPiSubscribeContext, chunk: string) {
  if (ctx.blockChunker) {
    ctx.blockChunker.append(chunk);
    return;
  }
  ctx.state.blockBuffer += chunk;
}

function replaceBlockReplyBuffer(ctx: EmbeddedPiSubscribeContext, text: string) {
  if (ctx.blockChunker) {
    ctx.blockChunker.reset();
    ctx.blockChunker.append(text);
    return;
  }
  ctx.state.blockBuffer = text;
}

function resolveAssistantTextChunk(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  delta: string;
  content: string;
  accumulatedText: string;
}): string {
  const { evtType, delta, content, accumulatedText } = params;
  if (evtType === "text_delta") {
    return delta;
  }
  if (delta) {
    return delta;
  }
  if (!content) {
    return "";
  }
  // KNOWN: Some providers resend full content on `text_end`.
  // We only append a suffix (or nothing) to keep output monotonic.
  if (content.startsWith(accumulatedText)) {
    return content.slice(accumulatedText.length);
  }
  if (accumulatedText.startsWith(content)) {
    return "";
  }
  if (!accumulatedText.includes(content)) {
    return content;
  }
  return "";
}

export function resolveSilentReplyFallbackText(params: {
  text: unknown;
  messagingToolSentTexts: string[];
}): string {
  const text = coerceChatContentText(params.text);
  const trimmed = text.trim();
  if (trimmed !== SILENT_REPLY_TOKEN) {
    return text;
  }
  const fallback = coerceChatContentText(params.messagingToolSentTexts.at(-1)).trim();
  if (!fallback) {
    return text;
  }
  return fallback;
}

function clearPendingToolMedia(
  state: Pick<EmbeddedPiSubscribeState, "pendingToolMediaUrls" | "pendingToolAudioAsVoice">,
) {
  state.pendingToolMediaUrls = [];
  state.pendingToolAudioAsVoice = false;
}

export function consumePendingToolMediaIntoReply(
  state: Pick<EmbeddedPiSubscribeState, "pendingToolMediaUrls" | "pendingToolAudioAsVoice">,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning) {
    return payload;
  }
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return payload;
  }
  const mergedMediaUrls = Array.from(
    new Set([...(payload.mediaUrls ?? []), ...state.pendingToolMediaUrls]),
  );
  const mergedPayload: BlockReplyPayload = {
    ...payload,
    mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
    audioAsVoice: payload.audioAsVoice || state.pendingToolAudioAsVoice || undefined,
  };
  clearPendingToolMedia(state);
  return mergedPayload;
}

export function consumePendingToolMediaReply(
  state: Pick<EmbeddedPiSubscribeState, "pendingToolMediaUrls" | "pendingToolAudioAsVoice">,
): BlockReplyPayload | null {
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return null;
  }
  const payload: BlockReplyPayload = {
    mediaUrls: state.pendingToolMediaUrls.length
      ? Array.from(new Set(state.pendingToolMediaUrls))
      : undefined,
    audioAsVoice: state.pendingToolAudioAsVoice || undefined,
  };
  clearPendingToolMedia(state);
  return payload;
}

export function hasAssistantVisibleReply(params: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
}): boolean {
  return resolveSendableOutboundReplyParts(params).hasContent || Boolean(params.audioAsVoice);
}

export function buildAssistantStreamData(params: {
  text?: string;
  delta?: string;
  replace?: boolean;
  mediaUrls?: string[];
  mediaUrl?: string;
  phase?: AssistantPhase;
}): {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  phase?: AssistantPhase;
} {
  const mediaUrls = resolveSendableOutboundReplyParts(params).mediaUrls;
  return {
    text: params.text ?? "",
    delta: params.delta ?? "",
    replace: params.replace ? true : undefined,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    phase: params.phase,
  };
}

export function handleMessageStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
  // ASSUME: `message_start` is the only reliable boundary for “new assistant message begins”.
  // Start-of-message is a safer reset point than message_end: some providers
  // may deliver late text_end updates after message_end, which would otherwise
  // re-trigger block replies.
  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
  // Use assistant message_start as the earliest "writing" signal for typing.
  void ctx.params.onAssistantMessageStart?.();
}

export function handleMessageUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  ctx.noteLastAssistant(msg);
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(msg);
  if (suppressVisibleAssistantOutput) {
    return;
  }
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);

  const assistantEvent = evt.assistantMessageEvent;
  const assistantPhase = resolveAssistantMessagePhase(msg);
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";

  if (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {
    if (evtType === "thinking_start" || evtType === "thinking_delta") {
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
    if (ctx.state.streamReasoning) {
      // Prefer full partial-message thinking when available; fall back to event payloads.
      const partialThinking = extractAssistantThinking(msg);
      ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta);
    }
    if (evtType === "thinking_end") {
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

  const partialAssistant =
    assistantRecord?.partial && typeof assistantRecord.partial === "object"
      ? (assistantRecord.partial as AssistantMessage)
      : msg;
  const deliveryPhase = resolveAssistantMessagePhase(partialAssistant);
  const streamItemId = resolveAssistantStreamItemId({
    contentIndex: assistantRecord?.contentIndex,
    message: partialAssistant,
  });
  if (deliveryPhase && streamItemId) {
    const previousStreamItemId = ctx.state.lastAssistantStreamItemId;
    if (previousStreamItemId && previousStreamItemId !== streamItemId) {
      void ctx.flushBlockReplyBuffer({ assistantMessageIndex: ctx.state.assistantMessageIndex });
      ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
      void ctx.params.onAssistantMessageStart?.();
    }
    ctx.state.lastAssistantStreamItemId = streamItemId;
  }
  if (deliveryPhase === "commentary") {
    return;
  }
  const phaseAwareVisibleText = coerceChatContentText(
    extractAssistantVisibleText(partialAssistant),
  ).trim();
  const shouldUsePhaseAwareBlockReply = Boolean(deliveryPhase);

  if (chunk) {
    ctx.state.deltaBuffer += chunk;
    if (!shouldUsePhaseAwareBlockReply) {
      appendBlockReplyChunk(ctx, chunk);
    }
  }

  if (ctx.state.streamReasoning) {
    // Handle partial <think> tags: stream whatever reasoning is visible so far.
    ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
  }
  const next =
    phaseAwareVisibleText ||
    (deliveryPhase === "final_answer"
      ? ""
      : ctx
          .stripBlockTags(ctx.state.deltaBuffer, {
            thinking: false,
            final: false,
            inlineCode: createInlineCodeState(),
          })
          .trim());
  if (next) {
    const wasThinking = ctx.state.partialBlockState.thinking;
    const visibleDelta = chunk ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState) : "";
    if (!wasThinking && ctx.state.partialBlockState.thinking) {
      openReasoningStream(ctx);
    }
    // Detect when thinking block ends (</think> tag processed)
    if (wasThinking && !ctx.state.partialBlockState.thinking) {
      emitReasoningEnd(ctx);
    }
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const parsedFull = parseReplyDirectives(stripTrailingDirective(next));
    const cleanedText = parsedFull.text;
    const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedDelta ?? {});
    const hasAudio = Boolean(parsedDelta?.audioAsVoice);
    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";

    let shouldEmit = false;
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
    }

    ctx.state.lastStreamedAssistant = next;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;

    if (ctx.params.silentExpected || suppressDeterministicApprovalOutput) {
      shouldEmit = false;
    }

    if (shouldEmit) {
      const data = buildAssistantStreamData({
        text: cleanedText,
        delta: deltaText,
        replace,
        mediaUrls,
        phase: assistantPhase,
      });
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "assistant",
        data,
      });
      void ctx.params.onAgentEvent?.({
        stream: "assistant",
        data,
      });
      ctx.state.emittedAssistantUpdate = true;
      if (ctx.params.onPartialReply && ctx.state.shouldEmitPartialReplies) {
        void ctx.params.onPartialReply(data);
      }
    }
  }

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    ctx.params.onBlockReply &&
    ctx.blockChunking &&
    ctx.state.blockReplyBreak === "text_end"
  ) {
    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
  }

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    evtType === "text_end" &&
    ctx.state.blockReplyBreak === "text_end"
  ) {
    const assistantMessageIndex = ctx.state.assistantMessageIndex;
    void Promise.resolve()
      .then(() => ctx.flushBlockReplyBuffer({ assistantMessageIndex }))
      .catch((err) => {
        ctx.log.debug(`text_end block reply flush failed: ${String(err)}`);
      });
  }
}

export function handleMessageEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
): void | Promise<void> {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  const assistantMessage = msg;
  const assistantPhase = resolveAssistantMessagePhase(assistantMessage);
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(assistantMessage);
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  ctx.noteLastAssistant(assistantMessage);
  ctx.recordAssistantUsage((assistantMessage as { usage?: unknown }).usage);
  if (suppressVisibleAssistantOutput) {
    return;
  }
  promoteThinkingTagsToBlocks(assistantMessage);

  const rawText = coerceChatContentText(extractAssistantText(assistantMessage));
  const rawVisibleText = coerceChatContentText(extractAssistantVisibleText(assistantMessage));
  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    rawText,
    rawThinking: extractAssistantThinking(assistantMessage),
  });

  const text = resolveSilentReplyFallbackText({
    text: ctx.stripBlockTags(rawVisibleText, { thinking: false, final: false }),
    messagingToolSentTexts: ctx.state.messagingToolSentTexts,
  });
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const formattedReasoning = rawThinking ? formatReasoningMessage(rawThinking) : "";
  const trimmedText = text.trim();
  const parsedText = trimmedText ? parseReplyDirectives(stripTrailingDirective(trimmedText)) : null;
  let cleanedText = parsedText?.text ?? "";
  let { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedText ?? {});

  const finalizeMessageEnd = () => {
    ctx.state.deltaBuffer = "";
    ctx.state.blockBuffer = "";
    ctx.blockChunker?.reset();
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();
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
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "assistant",
      data,
    });
    void ctx.params.onAgentEvent?.({
      stream: "assistant",
      data,
    });
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
    ctx.state.includeReasoning &&
    formattedReasoning &&
    onBlockReply &&
    formattedReasoning !== ctx.state.lastReasoningSent,
  );
  const shouldEmitReasoningBeforeAnswer =
    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" && !addedDuringMessage;
  const maybeEmitReasoning = () => {
    if (!shouldEmitReasoning || !formattedReasoning) {
      return;
    }
    ctx.state.lastReasoningSent = formattedReasoning;
    ctx.emitBlockReply({ text: formattedReasoning, isReasoning: true });
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
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    // Emit if there's content OR audioAsVoice flag (to propagate the flag).
    if (hasAssistantVisibleReply({ text: cleanedText, mediaUrls, audioAsVoice })) {
      ctx.emitBlockReply({
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      });
    }
  };

  const hasBufferedBlockReply = ctx.blockChunker
    ? ctx.blockChunker.hasBuffered()
    : ctx.state.blockBuffer.length > 0;

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    text &&
    onBlockReply &&
    (ctx.state.blockReplyBreak === "message_end" ||
      hasBufferedBlockReply ||
      text !== ctx.state.lastBlockReplyText)
  ) {
    if (hasBufferedBlockReply && ctx.blockChunker?.hasBuffered()) {
      ctx.blockChunker.drain({ force: true, emit: ctx.emitBlockChunk });
      ctx.blockChunker.reset();
    } else if (text !== ctx.state.lastBlockReplyText) {
      // Guard: for text_end channels, if text_end already delivered content
      // (lastBlockReplyText is set), skip this safety send. The text comparison
      // here uses a different stripping pipeline (stripBlockTags with reset state)
      // than emitBlockChunk (stripBlockTags with running blockState +
      // stripDowngradedToolCallText), which can false-positive. When text_end
      // didn't deliver (e.g. commentary suppressed, provider skipped text_end),
      // lastBlockReplyText is still null and message_end must deliver.
      if (ctx.state.blockReplyBreak === "text_end" && ctx.state.lastBlockReplyText != null) {
        ctx.log.debug(
          `Skipping message_end safety send for text_end channel - content already delivered via text_end`,
        );
      } else {
        // Check for duplicates before emitting (same logic as emitBlockChunk).
        const normalizedText = normalizeTextForComparison(text);
        if (
          isMessagingToolDuplicateNormalized(
            normalizedText,
            ctx.state.messagingToolSentTextsNormalized,
          )
        ) {
          ctx.log.debug(
            `Skipping message_end block reply - already sent via messaging tool: ${text.slice(0, 50)}...`,
          );
        } else {
          ctx.state.lastBlockReplyText = text;
          emitSplitResultAsBlockReply(ctx.consumeReplyDirectives(text, { final: true }));
        }
      }
    }
  }

  if (!shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }
  if (!ctx.params.silentExpected && ctx.state.streamReasoning && rawThinking) {
    ctx.emitReasoningStream(rawThinking);
  }

  if (!ctx.params.silentExpected && ctx.state.blockReplyBreak === "text_end" && onBlockReply) {
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
          const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
          if (isPromiseLike<void>(onBlockReplyFlushResult)) {
            return onBlockReplyFlushResult;
          }
          return undefined;
        })
        .finally(() => {
          finalizeMessageEnd();
        });
    }
    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult.finally(() => {
        finalizeMessageEnd();
      });
    }
  }

  finalizeMessageEnd();
  return undefined;
}
