// Telegram long-text fragment buffering and ordered flush.
import type { Message } from "grammy/types";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import type { TelegramContext } from "./bot/types.js";

type TextFragmentEntry = {
  key: string;
  storeAllowFrom: string[];
  messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeKeys: string[];
  spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  timer: ReturnType<typeof setTimeout>;
};

type TelegramTextFragmentInput = {
  ctx: TelegramContext;
  msg: Message;
  chatId: number;
  resolvedThreadId?: number;
  dmThreadId?: number;
  storeAllowFrom: string[];
  isAbortControlMessage: boolean;
  isAuthorizedAbortControlMessage: () => Promise<boolean>;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeKeys: string[];
};

export function createTelegramInboundTextRuntime(
  { opts, runtime }: Pick<RegisterTelegramHandlerParams, "opts" | "runtime">,
  messageRuntime: TelegramHandlerMessageRuntime,
) {
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeKeys,
    releaseDispatchDedupeKeys,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    processMessageWithReplyChain,
  } = messageRuntime;
  const maxGapMs =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : 1500;
  const buffer = new Map<string, TextFragmentEntry>();
  const queue = new KeyedAsyncQueue();

  const flush = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const combinedText = entry.messages.map((message) => message.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const result = await processMessageWithReplyChain({
        ctx: buildSyntheticContext(first.ctx, syntheticMessage),
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          messageIdOverride: String(last.msg.message_id),
          ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
            entry.messages.map((message) => message.msg),
          ),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "text-fragment",
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
        },
        dispatchDedupeKeys: entry.dispatchDedupeKeys,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (error) {
      releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, error);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`text fragment handler failed: ${String(error)}`));
    }
  };
  const queueFlush = async (entry: TextFragmentEntry) => {
    await queue.enqueue(entry.key, async () => {
      await flush(entry).catch(() => undefined);
    });
  };
  const runFlush = async (entry: TextFragmentEntry) => {
    buffer.delete(entry.key);
    await queueFlush(entry);
  };
  const scheduleFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void runFlush(entry), maxGapMs);
  };

  const handleTextFragment = async (params: TelegramTextFragmentInput): Promise<boolean> => {
    const text = typeof params.msg.text === "string" ? params.msg.text : undefined;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    const senderId = params.msg.from?.id != null ? String(params.msg.from.id) : "unknown";
    const threadId = params.resolvedThreadId ?? params.dmThreadId;
    const key = `text:${params.chatId}:${threadId ?? "main"}:${senderId}`;
    if (text && !isCommandLike && !params.isAbortControlMessage) {
      const nowMs = Date.now();
      const existing = buffer.get(key);
      if (existing) {
        const last = existing.messages.at(-1);
        const idGap = last ? params.msg.message_id - last.msg.message_id : Infinity;
        const timeGapMs = nowMs - (last?.receivedAtMs ?? nowMs);
        const canAppend = idGap > 0 && idGap <= 1 && timeGapMs >= 0 && timeGapMs <= maxGapMs;
        const nextTotalChars =
          existing.messages.reduce((sum, message) => sum + (message.msg.text?.length ?? 0), 0) +
          text.length;
        if (canAppend && existing.messages.length < 12 && nextTotalChars <= 50_000) {
          const participant = createSpooledReplayParticipantForBufferedWork(
            `text-fragment:${key}:${params.msg.message_id}`,
          );
          if (participant) {
            existing.spooledReplayParticipants.push(participant);
          }
          existing.messages.push({ msg: params.msg, ctx: params.ctx, receivedAtMs: nowMs });
          existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
            existing.promptContextMinTimestampMs,
            params.promptContextMinTimestampMs,
          );
          existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
            existing.promptContextAmbientWatermark,
            params.promptContextAmbientWatermark,
          );
          existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(
            existing.dispatchDedupeKeys,
            params.dispatchDedupeKeys,
          );
          scheduleFlush(existing);
          return true;
        }
        clearTimeout(existing.timer);
        buffer.delete(key);
        await queueFlush(existing);
      }
      if (text.length >= 4000) {
        const participant = createSpooledReplayParticipantForBufferedWork(
          `text-fragment:${key}:${params.msg.message_id}`,
        );
        const entry: TextFragmentEntry = {
          key,
          storeAllowFrom: params.storeAllowFrom,
          messages: [{ msg: params.msg, ctx: params.ctx, receivedAtMs: nowMs }],
          dispatchDedupeKeys: params.dispatchDedupeKeys,
          spooledReplayParticipants: participant ? [participant] : [],
          ...promptContextBoundaryOptions(
            params.promptContextMinTimestampMs,
            params.promptContextAmbientWatermark,
          ),
          timer: setTimeout(() => {}, maxGapMs),
        };
        buffer.set(key, entry);
        scheduleFlush(entry);
        return true;
      }
    } else if (
      text &&
      params.isAbortControlMessage &&
      (await params.isAuthorizedAbortControlMessage())
    ) {
      const existing = buffer.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        buffer.delete(key);
        releaseDispatchDedupeKeys(existing.dispatchDedupeKeys);
        settleSpooledReplayParticipants(existing.spooledReplayParticipants, { kind: "skipped" });
      }
    }
    return false;
  };

  return { handleTextFragment };
}
