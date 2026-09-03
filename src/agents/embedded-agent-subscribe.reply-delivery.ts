import { randomUUID } from "node:crypto";
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
  recordDeferredAssistantReplyDirectives,
  recordDeliveredAssistantReplyDirectives,
  recordDeliveredAutoMedia,
  restorePendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  AssistantStreamData,
  EmbeddedAgentSubscribeContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type AssistantStreamDelivery = {
  data: AssistantStreamData;
  eventData?: AssistantStreamData;
  emitPartialReply: boolean;
  finalMessage: boolean;
  blockIndex: number;
};

type AssistantStreamScope = {
  delivery?: AssistantStreamDelivery;
  active?: boolean;
  pending?: boolean;
  emitted?: boolean;
};

const isStreamAppend = ({ data, finalMessage }: AssistantStreamDelivery) =>
  !finalMessage && !data.replace && !data.mediaUrls?.length && !data.managedMediaUrls?.length;
const mergeStreamAppend = (previous: AssistantStreamData, next: AssistantStreamData) => ({
  ...next,
  delta: previous.delta + next.delta,
});

type ReplyDeliveryParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
};

export function createReplyDelivery({ params, state, log }: ReplyDeliveryParams) {
  const assistantTexts = state.assistantTexts;
  const deferredAssistantScopes: AssistantStreamScope[] = [];
  const lastEmittedCommentaryByItem = new Map<string, string>();
  const pendingBlockReplyTasks = new Map<Promise<void>, number>();
  const pendingPartialReplyTasks = new Set<Promise<void>>();
  let streamScope: AssistantStreamScope = {};
  const drainPartialReply = (scope: AssistantStreamScope) => {
    if (
      !scope.delivery ||
      !scope.pending ||
      state.unsubscribed ||
      (scope === streamScope && scope.active)
    ) {
      return;
    }
    const data = scope.delivery.data;
    scope.pending = false;
    // Reserve before invocation: callbacks may synchronously enqueue text or open another scope.
    scope.active = true;
    const settled = () => {
      if (scope === streamScope) {
        scope.active = false;
        drainPartialReply(scope);
      }
    };
    runBestEffortCallback({
      callback: () => params.onPartialReply?.(data),
      label: "assistant partial reply",
      log,
      pending: pendingPartialReplyTasks,
      onSuccess: settled,
      onError: settled,
    });
  };
  // Retry subscriptions reuse run IDs and reset message counters. Their scopes
  // must stay distinct so a correction cannot overwrite an earlier attempt.
  const streamId = randomUUID();
  let messageIndex = -1;
  let blockIndex = -1;
  let assistantItemId = "";
  let prefix = "";
  let streamedText = "";
  let finalized = false;
  const emitAssistantStreamDataSafely = (scope: AssistantStreamScope) => {
    if (!scope.delivery || scope.emitted || state.unsubscribed) {
      return;
    }
    const delivery = scope.delivery;
    const { eventData } = delivery;
    scope.emitted = true;
    scope.pending ||=
      delivery.emitPartialReply && Boolean(params.onPartialReply) && state.shouldEmitPartialReplies;
    const itemId = eventData?.itemId ?? "";
    const progressText =
      eventData?.phase === "commentary" ? eventData.text.replace(/\s+/g, " ").trim() : "";
    const preamblePhase = delivery.finalMessage ? "end" : "update";
    // Completion must survive an identical last delta: first-notification
    // consumers wait for this boundary, not a timer or a repeated text snapshot.
    const commentarySignature = `${preamblePhase}\0${progressText}`;
    const event = progressText
      ? {
          stream: "item" as const,
          data: {
            kind: "preamble",
            title: "Preamble",
            phase: preamblePhase,
            progressText,
            ...(itemId ? { itemId } : {}),
          },
        }
      : !eventData || eventData.phase === "commentary"
        ? undefined
        : { stream: "assistant" as const, data: eventData };
    if (
      event &&
      (event.stream !== "item" || lastEmittedCommentaryByItem.get(itemId) !== commentarySignature)
    ) {
      if (event.stream === "item") {
        lastEmittedCommentaryByItem.set(itemId, commentarySignature);
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
    drainPartialReply(scope);
  };
  const emitAssistantStreamData: EmbeddedAgentSubscribeContext["emitAssistantStreamData"] = (
    data,
    options,
  ) => {
    if (state.unsubscribed) {
      return;
    }
    let eventData: AssistantStreamData | undefined;
    if (data.phase === "commentary") {
      eventData = data;
    } else {
      if (messageIndex !== state.assistantMessageStartIndex) {
        messageIndex = state.assistantMessageStartIndex;
        blockIndex = state.assistantMessageIndex;
        assistantItemId = `${streamId}:${messageIndex}`;
        prefix = streamedText = "";
        finalized = false;
      }
      if (!finalized || options?.finalMessage) {
        if (blockIndex !== state.assistantMessageIndex) {
          prefix = streamedText;
          blockIndex = state.assistantMessageIndex;
        }
        const text = options?.finalMessage
          ? data.text
          : prefix && data.text
            ? `${prefix}\n${data.text}`
            : prefix || data.text;
        const replace = options?.finalMessage
          ? !text.startsWith(streamedText)
          : data.replace === true;
        const delta = options?.finalMessage
          ? replace
            ? ""
            : text.slice(streamedText.length)
          : prefix && streamedText.length === prefix.length && data.delta
            ? `\n${data.delta}`
            : data.delta;
        if (text !== streamedText || data.mediaUrls?.length || data.managedMediaUrls?.length) {
          eventData = {
            ...data,
            text,
            delta,
            replace: replace || undefined,
            itemId: assistantItemId,
          };
        }
        streamedText = text;
        finalized = options?.finalMessage === true;
      }
    }
    // Capture both coordinate domains before any callback can advance message state.
    const delivery = {
      data,
      eventData,
      emitPartialReply: options?.emitPartialReply === true,
      finalMessage: options?.finalMessage === true,
      blockIndex: state.assistantMessageIndex,
    };
    if (!eventData && !delivery.emitPartialReply) {
      return;
    }
    const previous = streamScope.delivery;
    const deferred = state.deferBlockReplyDelivery && data.phase !== "commentary";
    const coalesce =
      previous &&
      isStreamAppend(previous) &&
      isStreamAppend(delivery) &&
      previous.blockIndex === delivery.blockIndex &&
      previous.data.phase === data.phase &&
      previous.data.itemId === data.itemId &&
      previous.emitPartialReply === delivery.emitPartialReply &&
      Boolean(previous.eventData) === Boolean(eventData);
    const scope = coalesce ? streamScope : flushAssistantStream(delivery);
    if (coalesce) {
      // A reentrant boundary may append before this scope has emitted its first snapshot.
      if (!scope.emitted || scope.pending) {
        delivery.data = mergeStreamAppend(previous.data, data);
      }
      if (!scope.emitted && previous.eventData && eventData) {
        delivery.eventData = mergeStreamAppend(previous.eventData, eventData);
      }
      scope.delivery = delivery;
      scope.emitted = false;
    }
    if (!deferred) {
      emitAssistantStreamDataSafely(scope);
    }
  };
  const flushAssistantStream = (delivery?: AssistantStreamDelivery) => {
    // Publish the next scope before callbacks: a reentrant boundary can flush it exactly once.
    const previous = streamScope;
    const scope: AssistantStreamScope = { delivery };
    streamScope = scope;
    if (delivery && state.deferBlockReplyDelivery && delivery.data.phase !== "commentary") {
      deferredAssistantScopes.push(scope);
    }
    if (!state.deferBlockReplyDelivery) {
      for (const deferred of deferredAssistantScopes.splice(0)) {
        emitAssistantStreamDataSafely(deferred);
        deferred.delivery = undefined;
      }
    }
    if (!state.deferBlockReplyDelivery || previous.delivery?.data.phase === "commentary") {
      emitAssistantStreamDataSafely(previous);
      drainPartialReply(previous);
      previous.delivery = undefined;
    }
    return scope;
  };
  const clearAssistantStream = () => {
    streamScope.delivery = undefined;
    streamScope = {};
    deferredAssistantScopes.length = 0;
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
    const recordDeliveryFailure = () => {
      if (options?.pendingToolMedia) {
        restorePendingToolMediaReply(state, options.pendingToolMedia);
      }
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
        () => {
          recordDeliveryFailure();
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
    } catch {
      recordDeliveryFailure();
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
    flushAssistantStream();
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
        recordDeferredAssistantReplyDirectives(state, taggedPayload);
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
          recordDeliveredAssistantReplyDirectives(state, taggedPayload);
          state.visibleBlockReplyCount += 1;
          if (pendingToolMedia) {
            state.pendingToolMediaDeliveryFailed = false;
            state.hasToolMediaBlockReply = true;
          }
          recordDeliveredAutoMedia(state, autoDeliveryMediaUrls);
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
          recordDeliveredAssistantReplyDirectives(state, payload);
          state.visibleBlockReplyCount += 1;
          if (pendingToolMedia) {
            state.pendingToolMediaDeliveryFailed = false;
            state.hasToolMediaBlockReply = true;
          }
          recordDeliveredAutoMedia(state, deferredToolMedia?.autoDeliveryMediaUrls);
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
          if (!params.blockReplyChunking && params.onBlockReplyFlush) {
            await Promise.allSettled(pending);
            if (params.blockReplyBreak === "message_end") {
              await params.onBlockReplyFlush({ reason: "message_end" });
            }
          }
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
    state.lastAssistantTextContentIndex = state.lastAssistantStreamContentIndex;
    state.lastAssistantTextItemId = state.lastAssistantStreamItemId;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string, normalizedText?: string) => {
    // Distinct provider content blocks may legitimately contain identical text.
    if (
      state.lastAssistantTextMessageIndex !== state.assistantMessageIndex ||
      state.lastAssistantTextContentIndex !== state.lastAssistantStreamContentIndex
    ) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
      return true;
    }
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    return normalized.length > 0 && normalized === state.lastAssistantTextNormalized;
  };

  const pushAssistantText = (text: string, normalizedText?: string) => {
    if (!text) {
      return;
    }
    if (params.silentExpected && !isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
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
    if (state.hasFlushedPartialText) {
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
    clearAssistantStream,
    clearDeferredBlockReplies,
    currentPendingBlockReplyTasks,
    emitAssistantStreamData,
    emitBlockReply,
    finalizeAssistantTexts,
    flushAssistantStream,
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
