import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type ReplyDeliveryParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
};

export function createReplyDelivery({ params, state, log }: ReplyDeliveryParams) {
  const assistantTexts = state.assistantTexts;
  const pendingBlockReplyTasks = new Set<Promise<void>>();
  const pendingPartialReplyTasks = new Set<Promise<void>>();
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
      try {
        const maybeTask = params.onPartialReply(data);
        if (isPromiseLike(maybeTask)) {
          const task = Promise.resolve(maybeTask)
            .then(() => undefined)
            .catch((error: unknown) => {
              log.warn(`assistant partial reply callback failed: ${String(error)}`);
            });
          pendingPartialReplyTasks.add(task);
          void task.finally(() => {
            pendingPartialReplyTasks.delete(task);
          });
        }
      } catch (error) {
        log.warn(`assistant partial reply callback failed: ${String(error)}`);
      }
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
    const assistantTranscriptMediaUrls = Array.from(new Set(payload.mediaUrls ?? []));
    const taggedPayload =
      options?.assistantMessageIndex !== undefined
        ? setReplyPayloadMetadata(withToolMedia, {
            assistantMessageIndex: options.assistantMessageIndex,
            ...(assistantTranscriptMediaUrls.length > 0 ? { assistantTranscriptMediaUrls } : {}),
          })
        : withToolMedia;
    if (state.deferBlockReplyDelivery) {
      if (consumesPendingToolMedia) {
        deferredToolMediaReplies.add(taggedPayload);
      }
      state.deferredBlockReplies.push(taggedPayload);
      return;
    }
    const emitted = emitBlockReplySafely(taggedPayload, options);
    if (emitted && !taggedPayload.isReasoning && hasAssistantVisibleReply(taggedPayload)) {
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

  const replaceCurrentAssistantText = (text: string) => {
    const count = assistantTexts.length - state.assistantTextBaseline;
    if (!text) {
      assistantTexts.splice(state.assistantTextBaseline, count);
    } else if (count > 0) {
      assistantTexts.splice(state.assistantTextBaseline, count, text);
      rememberAssistantText(text);
    } else {
      pushAssistantText(text);
    }
  };

  const finalizeAssistantTexts = (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered } = args;

    // A run-budget timeout flush may already have committed partial text for
    // this message. When message_end later finalizes the complete text, replace
    // the flushed partial instead of appending a duplicate. The partial stays
    // when message_end never arrives (hard run-budget abort) — that is the
    // salvage the timeout flush exists for.
    if (state.hasFlushedPartialText && text) {
      replaceCurrentAssistantText(text);
      state.hasFlushedPartialText = false;
      state.assistantTextBaseline = assistantTexts.length;
      return;
    }

    // If we're not streaming block replies, ensure the final payload includes
    // the final text even when interim streaming was enabled.
    if (state.includeReasoning && text && !params.onBlockReply) {
      replaceCurrentAssistantText(text);
      state.suppressBlockChunks = true;
    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
      // Non-streaming models (no text_delta): ensure assistantTexts gets the final
      // text when the chunker has nothing buffered to drain.
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  const waitForPendingEvents = async (options?: { includePartialReplies?: boolean }) => {
    // Partial presentation stays concurrent with provider events, but terminal
    // settlement must observe callbacks launched while the event chain drains.
    const includePartialReplies = options?.includePartialReplies !== false;
    while (true) {
      const eventChain = state.pendingEventChain;
      const partialReplyTasks = includePartialReplies ? [...pendingPartialReplyTasks] : [];
      if (!eventChain && partialReplyTasks.length === 0) {
        return;
      }
      await Promise.allSettled([...(eventChain ? [eventChain] : []), ...partialReplyTasks]);
    }
  };

  return {
    assistantTexts,
    clearDeferredAssistantEvents,
    clearDeferredBlockReplies,
    emitAssistantStreamData,
    emitBlockReply,
    finalizeAssistantTexts,
    flushDeferredAssistantEvents,
    flushDeferredBlockReplies,
    pendingBlockReplyTasks,
    pushAssistantText,
    replaceCurrentAssistantText,
    shouldSkipAssistantText,
    waitForPendingEvents,
  };
}
