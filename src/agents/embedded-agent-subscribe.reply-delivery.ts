import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
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
  restorePendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type ReplyDeliveryParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
};

export function createReplyDelivery({ params, state, log }: ReplyDeliveryParams) {
  const assistantTexts = state.assistantTexts;
  const lastEmittedCommentaryByItem = new Map<string, string>();
  const pendingBlockReplyTasks = new Map<Promise<void>, number>();
  const pendingPartialReplyTasks = new Set<Promise<void>>();
  const shouldAllowSilentTurnText = (text: string | undefined) =>
    Boolean(text && isSilentReplyText(text, SILENT_REPLY_TOKEN));
  const emitAssistantStreamDataSafely = (
    delivery: EmbeddedAgentSubscribeContext["state"]["deferredAssistantEvents"][number],
  ) => {
    const { data } = delivery;
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const progressText =
      data.phase === "commentary" && typeof data.text === "string"
        ? data.text.replace(/\s+/g, " ").trim()
        : "";
    const event = progressText
      ? {
          stream: "item" as const,
          data: {
            kind: "preamble",
            title: "Preamble",
            phase: "update",
            progressText,
            ...(itemId ? { itemId } : {}),
          },
        }
      : data.phase === "commentary"
        ? undefined
        : { stream: "assistant" as const, data };
    if (
      event &&
      (event.stream !== "item" || lastEmittedCommentaryByItem.get(itemId) !== progressText)
    ) {
      if (event.stream === "item") {
        lastEmittedCommentaryByItem.set(itemId, progressText);
      }
      emitAgentEvent({ runId: params.runId, ...event });
      if (params.onAgentEvent) {
        runBestEffortCallback({
          label: "assistant agent event",
          log,
          callback: () => params.onAgentEvent?.(event),
        });
      }
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
  const deferredToolMediaReplies = new WeakMap<
    BlockReplyPayload,
    { pendingToolMedia: BlockReplyPayload; autoDeliveryMediaUrls: string[] }
  >();
  const deferredBlockReplyCallbacks = new WeakMap<BlockReplyPayload, () => void>();
  const failedBlockReplies: Array<{
    payload: BlockReplyPayload;
    options?: {
      assistantMessageIndex?: number;
      pendingToolMedia?: BlockReplyPayload | null;
      autoDeliveryMediaUrls?: string[];
    };
    onDelivered?: () => void;
    deliveryGeneration: number;
    deliveryKey: string;
    deliverySequence: number;
  }> = [];
  const exhaustedBlockReplyKeys = new Set<string>();
  let blockReplyDeliveryGeneration = 0;
  let blockReplyDeliverySequence = 0;
  let resolveBlockReplyDeliveryInvalidation: () => void = () => {};
  let blockReplyDeliveryInvalidation = new Promise<void>((resolve) => {
    resolveBlockReplyDeliveryInvalidation = resolve;
  });
  const blockReplyDeliveryKey = (
    payload: BlockReplyPayload,
    options?: { assistantMessageIndex?: number },
  ) =>
    JSON.stringify([
      options?.assistantMessageIndex,
      payload.text ?? "",
      payload.mediaUrls ?? [],
      payload.audioAsVoice === true,
      payload.replyToId ?? "",
      payload.replyToTag === true,
      payload.replyToCurrent === true,
      payload.isReasoning === true,
    ]);
  const mergeAssistantReplyDirectives = (
    current: EmbeddedAgentSubscribeState["lastDeliveredAssistantReplyDirectives"],
    payload: BlockReplyPayload,
  ) => {
    const mediaUrls = Array.from(
      new Set([...(current?.mediaUrls ?? []), ...(payload.mediaUrls ?? [])]),
    );
    if (
      mediaUrls.length === 0 &&
      !payload.audioAsVoice &&
      !payload.replyToId &&
      !payload.replyToTag &&
      !payload.replyToCurrent
    ) {
      return current;
    }
    return {
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      audioAsVoice: current?.audioAsVoice || payload.audioAsVoice || undefined,
      replyToId: payload.replyToId ?? current?.replyToId,
      replyToTag: current?.replyToTag || payload.replyToTag || undefined,
      replyToCurrent: current?.replyToCurrent || payload.replyToCurrent || undefined,
    };
  };
  const recordDeliveredAssistantReplyDirectives = (payload: BlockReplyPayload) => {
    state.lastDeliveredAssistantReplyDirectives = mergeAssistantReplyDirectives(
      state.lastDeliveredAssistantReplyDirectives,
      payload,
    );
  };
  const recordDeferredAssistantReplyDirectives = (payload: BlockReplyPayload) => {
    state.deferredAssistantReplyDirectives = mergeAssistantReplyDirectives(
      state.deferredAssistantReplyDirectives,
      payload,
    );
  };
  const recordDeliveredAutoMedia = (mediaUrls: readonly string[] | undefined) => {
    for (const url of mediaUrls ?? []) {
      state.toolAutoDeliveryMediaUrls.delete(url);
    }
  };
  const emitBlockReplySafely = (
    payload: Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0],
    options?: {
      assistantMessageIndex?: number;
      pendingToolMedia?: BlockReplyPayload | null;
      autoDeliveryMediaUrls?: string[];
    },
    onDelivered?: () => void,
    retrying = false,
    deliveryGeneration = blockReplyDeliveryGeneration,
    deliveryKey = blockReplyDeliveryKey(payload, options),
    deliverySequence = blockReplyDeliverySequence++,
  ): boolean => {
    if (!params.onBlockReply) {
      return false;
    }
    if (deliveryGeneration !== blockReplyDeliveryGeneration) {
      return false;
    }
    if (!retrying && exhaustedBlockReplyKeys.has(deliveryKey)) {
      log.warn("block reply callback retry already exhausted");
      return false;
    }
    const recordDeliveryFailure = (error: unknown) => {
      if (options?.pendingToolMedia) {
        restorePendingToolMediaReply(state, options.pendingToolMedia);
      }
      log.warn(`block reply callback failed: ${String(error)}`);
    };
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
        if (deliveryGeneration === blockReplyDeliveryGeneration) {
          exhaustedBlockReplyKeys.delete(deliveryKey);
          onDelivered?.();
        }
        return true;
      }
      const task = Promise.resolve(maybeTask).then(
        () => {
          if (deliveryGeneration === blockReplyDeliveryGeneration) {
            exhaustedBlockReplyKeys.delete(deliveryKey);
            onDelivered?.();
          }
        },
        (err: unknown) => {
          recordDeliveryFailure(err);
          if (deliveryGeneration !== blockReplyDeliveryGeneration) {
            return;
          }
          if (options?.pendingToolMedia) {
            return;
          }
          if (!retrying) {
            failedBlockReplies.push({
              payload,
              options,
              onDelivered,
              deliveryGeneration,
              deliveryKey,
              deliverySequence,
            });
          } else {
            exhaustedBlockReplyKeys.add(deliveryKey);
          }
        },
      );
      pendingBlockReplyTasks.set(task, deliveryGeneration);
      void task.finally(() => {
        pendingBlockReplyTasks.delete(task);
      });
      return true;
    } catch (err) {
      recordDeliveryFailure(err);
      if (deliveryGeneration !== blockReplyDeliveryGeneration) {
        return false;
      }
      if (options?.pendingToolMedia) {
        return false;
      }
      if (!retrying) {
        failedBlockReplies.push({
          payload,
          options,
          onDelivered,
          deliveryGeneration,
          deliveryKey,
          deliverySequence,
        });
      } else {
        exhaustedBlockReplyKeys.add(deliveryKey);
      }
      return false;
    }
  };
  const emitBlockReply = (
    payload: BlockReplyPayload,
    options?: {
      assistantMessageIndex?: number;
      consumePendingToolMedia?: boolean;
      onDelivered?: () => void;
    },
  ) => {
    const withAssistantDirectives = consumePendingAssistantReplyDirectivesIntoReply(state, payload);
    const pendingToolMedia =
      payload.isReasoning || options?.consumePendingToolMedia === false
        ? null
        : readPendingToolMediaReply(state);
    const withToolMedia =
      options?.consumePendingToolMedia === false
        ? withAssistantDirectives
        : consumePendingToolMediaIntoReply(state, withAssistantDirectives);
    const sentMediaUrls = new Set(state.messagingToolSentMediaUrls.map((url) => url.trim()));
    const autoDeliveryMediaUrls =
      params.sourceReplyDeliveryMode === "message_tool_only"
        ? (pendingToolMedia?.mediaUrls ?? []).filter(
            (url) =>
              state.toolAutoDeliveryMediaUrls.has(url.trim()) && !sentMediaUrls.has(url.trim()),
          )
        : [];
    const pendingAttachments = new Map(
      (pendingToolMedia?.mediaUrls ?? []).map((url, index) => [
        url.trim(),
        pendingToolMedia?.attachments?.[index] ?? {},
      ]),
    );
    const blockPayload: BlockReplyPayload =
      autoDeliveryMediaUrls.length === 0
        ? withToolMedia
        : markReplyPayloadForSourceSuppressionDelivery({
            mediaUrls: autoDeliveryMediaUrls,
            mediaUrl: autoDeliveryMediaUrls[0],
            attachments: autoDeliveryMediaUrls.map(
              (url) => pendingAttachments.get(url.trim()) ?? {},
            ),
            audioAsVoice: pendingToolMedia?.audioAsVoice || undefined,
            trustedLocalMedia: true,
          });
    const assistantTranscriptMediaUrls = Array.from(new Set(payload.mediaUrls ?? []));
    const taggedPayload =
      options?.assistantMessageIndex !== undefined
        ? setReplyPayloadMetadata(blockPayload, {
            assistantMessageIndex: options.assistantMessageIndex,
            ...(assistantTranscriptMediaUrls.length > 0 ? { assistantTranscriptMediaUrls } : {}),
          })
        : blockPayload;
    if (state.deferBlockReplyDelivery) {
      if (pendingToolMedia) {
        deferredToolMediaReplies.set(taggedPayload, {
          pendingToolMedia,
          autoDeliveryMediaUrls,
        });
      }
      if (!taggedPayload.isReasoning) {
        recordDeferredAssistantReplyDirectives(taggedPayload);
        if (taggedPayload.text) {
          state.deferredBlockReplyTexts.push(taggedPayload.text);
        }
      }
      if (options?.onDelivered) {
        deferredBlockReplyCallbacks.set(taggedPayload, options.onDelivered);
      }
      state.deferredBlockReplies.push(taggedPayload);
      return;
    }
    emitBlockReplySafely(
      taggedPayload,
      { ...options, pendingToolMedia, autoDeliveryMediaUrls },
      () => {
        if (!taggedPayload.isReasoning && hasAssistantVisibleReply(taggedPayload)) {
          recordDeliveredAssistantReplyDirectives(taggedPayload);
          state.visibleBlockReplyCount += 1;
          if (pendingToolMedia) {
            state.pendingToolMediaDeliveryFailed = false;
            state.hasToolMediaBlockReply = true;
          }
          recordDeliveredAutoMedia(autoDeliveryMediaUrls);
        }
        options?.onDelivered?.();
      },
    );
  };
  const flushDeferredBlockReplies = () => {
    if (state.deferredBlockReplies.length === 0) {
      return;
    }
    const deferred = state.deferredBlockReplies.splice(0);
    for (const payload of deferred) {
      const onDelivered = deferredBlockReplyCallbacks.get(payload);
      const deferredToolMedia = deferredToolMediaReplies.get(payload);
      const pendingToolMedia = deferredToolMedia?.pendingToolMedia;
      emitBlockReplySafely(payload, deferredToolMedia, () => {
        if (!payload.isReasoning && hasAssistantVisibleReply(payload)) {
          recordDeliveredAssistantReplyDirectives(payload);
          state.visibleBlockReplyCount += 1;
          if (pendingToolMedia) {
            state.pendingToolMediaDeliveryFailed = false;
            state.hasToolMediaBlockReply = true;
          }
          recordDeliveredAutoMedia(deferredToolMedia?.autoDeliveryMediaUrls);
        }
        onDelivered?.();
      });
    }
    state.deferredAssistantReplyDirectives = undefined;
    state.deferredBlockReplyTexts = [];
  };
  const clearDeferredBlockReplies = () => {
    state.deferredBlockReplies.length = 0;
    state.deferredAssistantReplyDirectives = undefined;
    state.deferredBlockReplyTexts = [];
  };

  // Continuation retry state (generation counter, invalidation promise,
  // failed/exhausted keys) lives at factory scope so emitBlockReplySafely and
  // these settle/retry closures share one owner; the parent drives them via the
  // returned object during compaction retries.
  const currentPendingBlockReplyTasks = () =>
    Array.from(pendingBlockReplyTasks)
      .filter(([, generation]) => generation === blockReplyDeliveryGeneration)
      .map(([task]) => task);
  const waitForPendingBlockReplies = (): Promise<void> =>
    (async () => {
      const deliveryGeneration = blockReplyDeliveryGeneration;
      const deliveryInvalidation = blockReplyDeliveryInvalidation;
      let pending = currentPendingBlockReplyTasks();
      while (pending.length > 0) {
        if (deliveryGeneration !== blockReplyDeliveryGeneration) {
          return;
        }
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          deliveryInvalidation,
        ]);
        if (deliveryGeneration !== blockReplyDeliveryGeneration) {
          return;
        }
        pending = currentPendingBlockReplyTasks();
      }
    })();
  const settleBlockReplyDeliveries = (options?: {
    retryFailures?: boolean;
  }): void | Promise<void> => {
    if (currentPendingBlockReplyTasks().length > 0) {
      return waitForPendingBlockReplies().then(() => settleBlockReplyDeliveries(options));
    }
    if (!options?.retryFailures || failedBlockReplies.length === 0) {
      return;
    }
    const failed = failedBlockReplies
      .splice(0)
      .toSorted((left, right) => left.deliverySequence - right.deliverySequence);
    for (const entry of failed) {
      emitBlockReplySafely(
        entry.payload,
        entry.options,
        entry.onDelivered,
        true,
        entry.deliveryGeneration,
        entry.deliveryKey,
        entry.deliverySequence,
      );
    }
    if (currentPendingBlockReplyTasks().length > 0 || failedBlockReplies.length > 0) {
      return settleBlockReplyDeliveries(options);
    }
  };
  const invalidateBlockReplyDeliveries = () => {
    blockReplyDeliveryGeneration += 1;
    resolveBlockReplyDeliveryInvalidation();
    blockReplyDeliveryInvalidation = new Promise<void>((resolve) => {
      resolveBlockReplyDeliveryInvalidation = resolve;
    });
    for (const [task, generation] of pendingBlockReplyTasks) {
      if (generation !== blockReplyDeliveryGeneration) {
        pendingBlockReplyTasks.delete(task);
      }
    }
  };
  const getBlockReplyDeliveryGeneration = () => blockReplyDeliveryGeneration;
  const resetBlockReplyFailures = () => {
    failedBlockReplies.length = 0;
    exhaustedBlockReplyKeys.clear();
  };

  const rememberAssistantText = (text: string, normalizedText?: string) => {
    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string, normalizedText?: string) => {
    if (state.lastAssistantTextMessageIndex !== state.assistantMessageIndex) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
      return true;
    }
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    if (normalized.length > 0 && normalized === state.lastAssistantTextNormalized) {
      return true;
    }
    return false;
  };

  const pushAssistantText = (text: string, normalizedText?: string) => {
    if (!text) {
      return;
    }
    if (params.silentExpected && !shouldAllowSilentTurnText(text)) {
      return;
    }
    if (shouldSkipAssistantText(text, normalizedText)) {
      return;
    }
    assistantTexts.push(text);
    rememberAssistantText(text, normalizedText);
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
    reconcileCurrentMessage?: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered, reconcileCurrentMessage } = args;

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
    if (reconcileCurrentMessage && addedDuringMessage) {
      replaceCurrentAssistantText(text);
    } else if (state.includeReasoning && text && !params.onBlockReply) {
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
    currentPendingBlockReplyTasks,
    emitAssistantStreamData,
    emitBlockReply,
    finalizeAssistantTexts,
    flushDeferredAssistantEvents,
    flushDeferredBlockReplies,
    getBlockReplyDeliveryGeneration,
    invalidateBlockReplyDeliveries,
    pendingBlockReplyTasks,
    pushAssistantText,
    replaceCurrentAssistantText,
    resetBlockReplyFailures,
    settleBlockReplyDeliveries,
    shouldSkipAssistantText,
    waitForPendingBlockReplies,
    waitForPendingEvents,
  };
}
