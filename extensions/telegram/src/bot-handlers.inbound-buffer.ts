import type { Message } from "grammy/types";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createTelegramBufferedDispatchAdmission } from "./bot-handlers.inbound-buffer-admission.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramChannelIngressResolver,
} from "./bot-message-context.types.js";
import type {
  TelegramMessageProcessingResult,
  TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import {
  buildTelegramThreadParams,
  getTelegramTextParts,
  joinTelegramTextParts,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type TelegramDebounceLane = "default" | "forward";

export type TelegramDebounceEntry = {
  ctx: TelegramContext;
  msg: Message;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  receivedAtMs: number;
  debounceKey: string | null;
  debounceLane: TelegramDebounceLane;
  botUsername?: string;
  threadSpec: TelegramThreadSpec;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
  cancelled: boolean;
  dispatchAdmission: "pending" | "admitted" | "cancelled";
  dispatchAbortControllers: Set<AbortController>;
  pendingIgnoreSettlements: Set<Promise<void>>;
};

type TextFragmentMessage = {
  msg: Message;
  ctx: TelegramContext;
  receivedAtMs: number;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolver: TelegramChannelIngressResolver;
  cancelled: boolean;
  dispatchAdmission: "pending" | "admitted" | "cancelled";
  dispatchAbortControllers: Set<AbortController>;
  pendingIgnoreSettlements: Set<Promise<void>>;
};

export type PendingBufferedMessageIgnore = {
  settle: (authorized: boolean) => boolean;
};

type TextFragmentEntry = {
  key: string;
  storeAllowFrom: string[];
  messages: TextFragmentMessage[];
  threadSpec: TelegramThreadSpec;
  timer: ReturnType<typeof setTimeout>;
};

type TelegramTextFragmentInput = {
  ctx: TelegramContext;
  msg: Message;
  chatId: number;
  threadSpec: TelegramThreadSpec;
  storeAllowFrom: string[];
  isAbortControlMessage: boolean;
  isAuthorizedAbortControlMessage: () => Promise<boolean>;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  channelIngressResolver: TelegramChannelIngressResolver;
};

interface TelegramInboundBuffers {
  inboundDebouncer: {
    enqueue: (entry: TelegramDebounceEntry) => Promise<void>;
    flushKey: (key: string) => Promise<void>;
    cancelKey: (key: string) => boolean;
    drain: () => Promise<void>;
  };
  resolveTelegramDebounceEntryMs: (entry: TelegramDebounceEntry) => number;
  shouldDebounceTelegramEntry: (entry: TelegramDebounceEntry) => boolean;
  resolveTelegramDebounceLane: (msg: Message) => TelegramDebounceLane;
  handleTextFragment: (params: TelegramTextFragmentInput) => Promise<boolean>;
  beginPendingBufferedMessageIgnore: (msg: Message) => PendingBufferedMessageIgnore | undefined;
}

export function createTelegramInboundBuffers({
  params: { cfg, bot, runtime, opts, removeMessageFromGroupHistory },
  message,
}: {
  params: Pick<
    RegisterTelegramHandlerParams,
    "cfg" | "bot" | "runtime" | "opts" | "removeMessageFromGroupHistory"
  >;
  message: TelegramMessagePipeline;
}): TelegramInboundBuffers {
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    processMessageWithReplyChain,
    removeMessageFromReplyChain,
  } = message;
  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  const resolveTelegramDebounceEntryMs = (entry: TelegramDebounceEntry): number =>
    entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs;
  const shouldDebounceTelegramEntry = (entry: TelegramDebounceEntry): boolean => {
    const hasDebounceableText = shouldDebounceTextInbound({
      text: getTelegramTextParts(entry.msg).text,
      cfg,
      commandOptions: { botUsername: entry.botUsername },
    });
    if (entry.debounceLane === "forward") {
      return hasDebounceableText || entry.allMedia.length > 0;
    }
    return hasDebounceableText && entry.allMedia.length === 0;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const bufferedMessageKey = (msg: Message) => `${msg.chat.id}:${msg.message_id}`;
  const debounceEntriesByMessage = new Map<string, Set<TelegramDebounceEntry>>();
  const textFragmentsByMessage = new Map<string, Set<TextFragmentMessage>>();
  const registerDebounceEntry = (entry: TelegramDebounceEntry) => {
    const key = bufferedMessageKey(entry.msg);
    const entries = debounceEntriesByMessage.get(key) ?? new Set();
    entries.add(entry);
    debounceEntriesByMessage.set(key, entries);
  };
  const forgetDebounceEntry = (entry: TelegramDebounceEntry) => {
    const key = bufferedMessageKey(entry.msg);
    const entries = debounceEntriesByMessage.get(key);
    entries?.delete(entry);
    if (entries?.size === 0) {
      debounceEntriesByMessage.delete(key);
    }
  };
  const registerTextFragment = (fragment: TextFragmentMessage) => {
    const key = bufferedMessageKey(fragment.msg);
    const fragments = textFragmentsByMessage.get(key) ?? new Set();
    fragments.add(fragment);
    textFragmentsByMessage.set(key, fragments);
  };
  const forgetTextFragment = (fragment: TextFragmentMessage) => {
    const key = bufferedMessageKey(fragment.msg);
    const fragments = textFragmentsByMessage.get(key);
    fragments?.delete(fragment);
    if (fragments?.size === 0) {
      textFragmentsByMessage.delete(key);
    }
  };
  const waitForPendingIgnore = async (owner: { pendingIgnoreSettlements: Set<Promise<void>> }) => {
    while (owner.pendingIgnoreSettlements.size > 0) {
      await Promise.all(owner.pendingIgnoreSettlements);
    }
  };
  const purgeIgnoredBufferedMessages = async (
    entries: readonly { msg: Message; threadSpec: TelegramThreadSpec }[],
  ) => {
    await Promise.all(
      entries.map(async (entry) => {
        // Context construction records rolling history before final dispatch admission. Repeat the
        // privacy purge here so a late context write cannot race an authorized edited /ignore.
        removeMessageFromGroupHistory(entry.msg, entry.threadSpec);
        try {
          await removeMessageFromReplyChain(entry.msg);
        } catch (error) {
          runtime.error?.(
            danger(`telegram buffered ignore privacy purge failed: ${String(error)}`),
          );
        }
      }),
    );
  };
  const settleCancelledDebounceEntries = async (entries: readonly TelegramDebounceEntry[]) => {
    for (const entry of entries) {
      releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
      if (entry.spooledReplayParticipant) {
        settleSpooledReplayParticipants([entry.spooledReplayParticipant], { kind: "skipped" });
      }
      forgetDebounceEntry(entry);
    }
    await purgeIgnoredBufferedMessages(entries);
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    onFlush: (queuedEntries) => {
      const processEntries = async (candidateEntries: TelegramDebounceEntry[]): Promise<void> => {
        await Promise.all(candidateEntries.map(waitForPendingIgnore));
        const cancelledEntries = candidateEntries.filter((entry) => entry.cancelled);
        await settleCancelledDebounceEntries(cancelledEntries);
        const entries = candidateEntries.filter((entry) => !entry.cancelled);
        const participants = entries
          .map((entry) => entry.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          );
        const last = entries.at(-1);
        if (!last) {
          return;
        }
        const bufferedDispatch = createTelegramBufferedDispatchAdmission(entries);
        let result: TelegramMessageProcessingResult;
        try {
          if (entries.length === 1) {
            result = await processMessageWithReplyChain({
              ctx: last.ctx,
              msg: last.msg,
              allMedia: last.allMedia,
              storeAllowFrom: last.storeAllowFrom,
              options: {
                receivedAtMs: last.receivedAtMs,
                ingressBuffer: "inbound-debounce",
                threadSpec: last.threadSpec,
                ...promptContextBoundaryOptions(
                  last.promptContextMinTimestampMs,
                  last.promptContextAmbientWatermark,
                ),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: last.channelIngressResolvers,
              },
              dispatchDedupeClaims: last.dispatchDedupeClaims,
              spooledReplayParticipants: participants,
              shouldSkipBeforeDispatch: async () => {
                await waitForPendingIgnore(last);
                return last.cancelled;
              },
              deferCancelledBeforeDispatchSettlement: true,
              dispatchAdmission: bufferedDispatch.admission,
            });
          } else {
            const combinedTextParts = joinTelegramTextParts(
              entries.map((entry) => entry.msg),
              "\n",
            );
            const combinedText = combinedTextParts.text;
            const combinedMedia = entries.flatMap((entry) => entry.allMedia);
            if (!combinedText.trim() && combinedMedia.length === 0) {
              releaseDispatchDedupeClaims(
                mergeDispatchDedupeClaims(...entries.map((entry) => entry.dispatchDedupeClaims)),
              );
              settleSpooledReplayParticipants(participants, { kind: "skipped" });
              for (const entry of entries) {
                forgetDebounceEntry(entry);
              }
              return;
            }
            const first = expectDefined(entries.at(0), "multi-entry Telegram debounce batch");
            const syntheticMessage = {
              ...buildSyntheticTextMessage({
                base: first.msg,
                text: combinedText,
                entities: combinedTextParts.entities,
                date: last.msg.date ?? first.msg.date,
              }),
              forward_origin: undefined,
            };
            result = await processMessageWithReplyChain({
              ctx: buildSyntheticContext(first.ctx, syntheticMessage),
              msg: syntheticMessage,
              allMedia: combinedMedia,
              storeAllowFrom: first.storeAllowFrom,
              options: {
                ...(last.msg.message_id ? { messageIdOverride: String(last.msg.message_id) } : {}),
                ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
                  entries.map((entry) => entry.msg),
                ),
                receivedAtMs: first.receivedAtMs,
                ingressBuffer: "inbound-debounce",
                threadSpec: first.threadSpec,
                bufferedMessages: entries.map((entry) => entry.msg),
                ...promptContextBoundaryOptions(
                  latestPromptContextMinTimestampMs(
                    ...entries.map((entry) => entry.promptContextMinTimestampMs),
                  ),
                  latestPromptContextAmbientWatermark(
                    ...entries.map((entry) => entry.promptContextAmbientWatermark),
                  ),
                ),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: entries.flatMap((entry) => entry.channelIngressResolvers),
              },
              dispatchDedupeClaims: mergeDispatchDedupeClaims(
                ...entries.map((entry) => entry.dispatchDedupeClaims),
              ),
              spooledReplayParticipants: participants,
              shouldSkipBeforeDispatch: async () => {
                await Promise.all(entries.map(waitForPendingIgnore));
                return entries.some((entry) => entry.cancelled);
              },
              deferCancelledBeforeDispatchSettlement: true,
              dispatchAdmission: bufferedDispatch.admission,
            });
          }
        } catch (error) {
          await purgeIgnoredBufferedMessages(entries.filter((entry) => entry.cancelled));
          settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
          for (const entry of entries) {
            forgetDebounceEntry(entry);
          }
          throw error;
        } finally {
          bufferedDispatch.release();
        }
        if (result.kind === "skipped" && result.reason === "cancelled-before-dispatch") {
          try {
            await processEntries(entries);
          } finally {
            for (const entry of entries) {
              forgetDebounceEntry(entry);
            }
          }
          return;
        }
        settleSpooledReplayParticipants(participants, result);
        for (const entry of entries) {
          forgetDebounceEntry(entry);
        }
      };
      const completion = processEntries(queuedEntries);
      // Spooled Telegram processing already returns at durable turn adoption;
      // its participant owns the remaining agent-turn lifecycle.
      return { admission: completion, completion };
    },
    onError: (error, items) => {
      const participants = items
        .map((item) => item.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
      runtime.error?.(danger(`telegram debounce flush failed: ${String(error)}`));
      if (participants.length > 0) {
        return;
      }
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadParams = buildTelegramThreadParams(items[0]?.threadSpec);
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadParams,
          )
          .catch((sendError: unknown) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendError)}`);
          });
      }
    },
    onCancel: (items) => {
      releaseDispatchDedupeClaims(
        mergeDispatchDedupeClaims(...items.map((item) => item.dispatchDedupeClaims)),
      );
      settleSpooledReplayParticipants(
        items
          .map((item) => item.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          ),
        { kind: "skipped" },
      );
      for (const item of items) {
        forgetDebounceEntry(item);
      }
    },
  });
  const enqueueDebounceEntry = async (entry: TelegramDebounceEntry) => {
    registerDebounceEntry(entry);
    try {
      await inboundDebouncer.enqueue(entry);
    } catch (error) {
      forgetDebounceEntry(entry);
      throw error;
    }
  };

  const maxGapMs =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : 1500;
  const textBuffer = new Map<string, TextFragmentEntry>();
  const textQueue = new KeyedAsyncQueue();

  const textFragmentParticipants = (messages: readonly TextFragmentMessage[]) =>
    messages.flatMap((fragment) =>
      fragment.spooledReplayParticipant ? [fragment.spooledReplayParticipant] : [],
    );
  const settleTextFragments = (messages: readonly TextFragmentMessage[]) => {
    for (const fragment of messages) {
      releaseDispatchDedupeClaims(fragment.dispatchDedupeClaims);
      if (fragment.spooledReplayParticipant) {
        settleSpooledReplayParticipants([fragment.spooledReplayParticipant], { kind: "skipped" });
      }
      forgetTextFragment(fragment);
    }
  };
  const createTextFragmentMessage = (
    params: TelegramTextFragmentInput,
    key: string,
    receivedAtMs: number,
  ): TextFragmentMessage => {
    const fragment: TextFragmentMessage = {
      msg: params.msg,
      ctx: params.ctx,
      receivedAtMs,
      ...promptContextBoundaryOptions(
        params.promptContextMinTimestampMs,
        params.promptContextAmbientWatermark,
      ),
      dispatchDedupeClaims: params.dispatchDedupeClaims,
      spooledReplayParticipant: createSpooledReplayParticipantForBufferedWork(
        `text-fragment:${key}:${params.msg.message_id}`,
      ),
      channelIngressResolver: params.channelIngressResolver,
      cancelled: false,
      dispatchAdmission: "pending",
      dispatchAbortControllers: new Set(),
      pendingIgnoreSettlements: new Set(),
    };
    registerTextFragment(fragment);
    return fragment;
  };

  const flushTextFragments = async (
    entry: TextFragmentEntry,
    candidateMessages: TextFragmentMessage[] = entry.messages,
  ): Promise<void> => {
    await Promise.all(candidateMessages.map(waitForPendingIgnore));
    const cancelledMessages = candidateMessages.filter((fragment) => fragment.cancelled);
    settleTextFragments(cancelledMessages);
    await purgeIgnoredBufferedMessages(
      cancelledMessages.map((fragment) => ({ msg: fragment.msg, threadSpec: entry.threadSpec })),
    );
    const messages = candidateMessages.filter((fragment) => !fragment.cancelled);
    const dispatchDedupeClaims = mergeDispatchDedupeClaims(
      ...messages.map((fragment) => fragment.dispatchDedupeClaims),
    );
    const spooledReplayParticipants = textFragmentParticipants(messages);
    const bufferedDispatch = createTelegramBufferedDispatchAdmission(messages);
    try {
      messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const bufferedMessages = messages.map((bufferedMessage) => bufferedMessage.msg);
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) {
        return;
      }
      const combinedTextParts = joinTelegramTextParts(bufferedMessages, "");
      const combinedText = combinedTextParts.text;
      if (!combinedText.trim()) {
        releaseDispatchDedupeClaims(dispatchDedupeClaims);
        settleSpooledReplayParticipants(spooledReplayParticipants, { kind: "skipped" });
        for (const fragment of messages) {
          forgetTextFragment(fragment);
        }
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        entities: combinedTextParts.entities,
        date: last.msg.date ?? first.msg.date,
      });
      const result = await processMessageWithReplyChain({
        ctx: buildSyntheticContext(first.ctx, syntheticMessage),
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          messageIdOverride: String(last.msg.message_id),
          ambientTranscriptBody: formatTelegramAmbientTranscriptBody(bufferedMessages),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "text-fragment",
          threadSpec: entry.threadSpec,
          bufferedMessages,
          ...promptContextBoundaryOptions(
            latestPromptContextMinTimestampMs(
              ...messages.map((fragment) => fragment.promptContextMinTimestampMs),
            ),
            latestPromptContextAmbientWatermark(
              ...messages.map((fragment) => fragment.promptContextAmbientWatermark),
            ),
          ),
          ...spooledReplayOptions(spooledReplayParticipants),
          channelIngressResolvers: messages.map((fragment) => fragment.channelIngressResolver),
        },
        dispatchDedupeClaims,
        spooledReplayParticipants,
        shouldSkipBeforeDispatch: async () => {
          await Promise.all(messages.map(waitForPendingIgnore));
          return messages.some((fragment) => fragment.cancelled);
        },
        deferCancelledBeforeDispatchSettlement: true,
        dispatchAdmission: bufferedDispatch.admission,
      });
      if (result.kind === "skipped" && result.reason === "cancelled-before-dispatch") {
        try {
          await flushTextFragments(entry, messages);
        } finally {
          for (const fragment of messages) {
            forgetTextFragment(fragment);
          }
        }
        return;
      }
      settleSpooledReplayParticipants(spooledReplayParticipants, result);
      for (const fragment of messages) {
        forgetTextFragment(fragment);
      }
    } catch (error) {
      await purgeIgnoredBufferedMessages(
        messages
          .filter((fragment) => fragment.cancelled)
          .map((fragment) => ({ msg: fragment.msg, threadSpec: entry.threadSpec })),
      );
      releaseDispatchDedupeClaims(dispatchDedupeClaims, error);
      settleSpooledReplayParticipants(
        spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`text fragment handler failed: ${String(error)}`));
      for (const fragment of messages) {
        forgetTextFragment(fragment);
      }
    } finally {
      bufferedDispatch.release();
    }
  };
  const queueTextFlush = async (entry: TextFragmentEntry) => {
    await textQueue.enqueue(entry.key, async () => {
      await flushTextFragments(entry).catch(() => undefined);
    });
  };
  const runTextFlush = async (entry: TextFragmentEntry) => {
    textBuffer.delete(entry.key);
    await queueTextFlush(entry);
  };
  const scheduleTextFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void runTextFlush(entry), maxGapMs);
  };
  const handleTextFragment = async (params: TelegramTextFragmentInput): Promise<boolean> => {
    const text = typeof params.msg.text === "string" ? params.msg.text : undefined;
    const isCommand = getTelegramTextParts(params.msg).entities.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    );
    const senderId = params.msg.from?.id != null ? String(params.msg.from.id) : "unknown";
    const key = `text:${params.chatId}:${params.threadSpec.scope}:${params.threadSpec.id ?? "main"}:${senderId}`;
    if (text && !isCommand && !params.isAbortControlMessage) {
      const nowMs = Date.now();
      const existing = textBuffer.get(key);
      if (existing) {
        const last = existing.messages.at(-1);
        const idGap = last ? params.msg.message_id - last.msg.message_id : Infinity;
        const timeGapMs = nowMs - (last?.receivedAtMs ?? nowMs);
        const canAppend = idGap > 0 && idGap <= 1 && timeGapMs >= 0 && timeGapMs <= maxGapMs;
        const nextTotalChars =
          existing.messages.reduce(
            (sum, bufferedMessage) => sum + (bufferedMessage.msg.text?.length ?? 0),
            0,
          ) + text.length;
        if (canAppend && existing.messages.length < 12 && nextTotalChars <= 50_000) {
          existing.messages.push(createTextFragmentMessage(params, key, nowMs));
          scheduleTextFlush(existing);
          return true;
        }
        clearTimeout(existing.timer);
        textBuffer.delete(key);
        await queueTextFlush(existing);
      }
      if (text.length >= 4000) {
        const entry: TextFragmentEntry = {
          key,
          storeAllowFrom: params.storeAllowFrom,
          threadSpec: params.threadSpec,
          messages: [createTextFragmentMessage(params, key, nowMs)],
          timer: setTimeout(() => {}, maxGapMs),
        };
        textBuffer.set(key, entry);
        scheduleTextFlush(entry);
        return true;
      }
    } else if (
      text &&
      params.isAbortControlMessage &&
      (await params.isAuthorizedAbortControlMessage())
    ) {
      const existing = textBuffer.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        textBuffer.delete(key);
        settleTextFragments(existing.messages);
      }
    }
    return false;
  };
  const beginPendingBufferedMessageIgnore = (
    msg: Message,
  ): PendingBufferedMessageIgnore | undefined => {
    const key = bufferedMessageKey(msg);
    const owners: Array<TelegramDebounceEntry | TextFragmentMessage> = [
      ...(debounceEntriesByMessage.get(key) ?? []),
      ...(textFragmentsByMessage.get(key) ?? []),
    ];
    if (owners.length === 0) {
      return undefined;
    }
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    for (const owner of owners) {
      owner.pendingIgnoreSettlements.add(settlement);
    }
    let settled = false;
    return {
      settle: (authorized) => {
        if (settled) {
          return true;
        }
        settled = true;
        for (const owner of owners) {
          if (authorized && owner.dispatchAdmission === "pending") {
            owner.cancelled = true;
            owner.dispatchAdmission = "cancelled";
            for (const controller of owner.dispatchAbortControllers) {
              controller.abort("skipped");
            }
          }
          owner.pendingIgnoreSettlements.delete(settlement);
        }
        resolveSettlement();
        return true;
      },
    };
  };

  return {
    inboundDebouncer: { ...inboundDebouncer, enqueue: enqueueDebounceEntry },
    resolveTelegramDebounceEntryMs,
    shouldDebounceTelegramEntry,
    resolveTelegramDebounceLane,
    handleTextFragment,
    beginPendingBufferedMessageIgnore,
  };
}
