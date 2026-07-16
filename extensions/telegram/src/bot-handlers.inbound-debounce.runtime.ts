// Telegram inbound debounce lanes and batch flushing.
import type { Message } from "grammy/types";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { getTelegramTextParts } from "./bot/helpers.js";
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
  threadId?: number;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
};

export function createTelegramInboundDebounceRuntime(
  { cfg, bot, runtime }: Pick<RegisterTelegramHandlerParams, "cfg" | "bot" | "runtime">,
  messageRuntime: TelegramHandlerMessageRuntime,
) {
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    processMessageWithReplyChain,
  } = messageRuntime;
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
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    onFlush: async (entries) => {
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
      try {
        if (entries.length === 1) {
          const result = await processMessageWithReplyChain({
            ctx: last.ctx,
            msg: last.msg,
            allMedia: last.allMedia,
            storeAllowFrom: last.storeAllowFrom,
            options: {
              receivedAtMs: last.receivedAtMs,
              ingressBuffer: "inbound-debounce",
              ...promptContextBoundaryOptions(
                last.promptContextMinTimestampMs,
                last.promptContextAmbientWatermark,
              ),
              ...spooledReplayOptions(participants),
            },
            dispatchDedupeClaims: last.dispatchDedupeClaims,
            spooledReplayParticipants: participants,
          });
          settleSpooledReplayParticipants(participants, result);
          return;
        }
        const combinedText = entries
          .map((entry) => getTelegramTextParts(entry.msg).text)
          .filter(Boolean)
          .join("\n");
        const combinedMedia = entries.flatMap((entry) => entry.allMedia);
        if (!combinedText.trim() && combinedMedia.length === 0) {
          releaseDispatchDedupeClaims(
            mergeDispatchDedupeClaims(...entries.map((entry) => entry.dispatchDedupeClaims)),
          );
          settleSpooledReplayParticipants(participants, { kind: "skipped" });
          return;
        }
        const first = expectDefined(entries.at(0), "multi-entry Telegram debounce batch");
        const syntheticMessage = buildSyntheticTextMessage({
          base: first.msg,
          text: combinedText,
          date: last.msg.date ?? first.msg.date,
        });
        const result = await processMessageWithReplyChain({
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
            ...promptContextBoundaryOptions(
              latestPromptContextMinTimestampMs(
                ...entries.map((entry) => entry.promptContextMinTimestampMs),
              ),
              latestPromptContextAmbientWatermark(
                ...entries.map((entry) => entry.promptContextAmbientWatermark),
              ),
            ),
            ...spooledReplayOptions(participants),
          },
          dispatchDedupeClaims: mergeDispatchDedupeClaims(
            ...entries.map((entry) => entry.dispatchDedupeClaims),
          ),
          spooledReplayParticipants: participants,
        });
        settleSpooledReplayParticipants(participants, result);
      } catch (error) {
        settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
        throw error;
      }
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
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadId != null ? { message_thread_id: threadId } : undefined,
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
    },
  });

  return {
    inboundDebouncer,
    resolveTelegramDebounceEntryMs,
    shouldDebounceTelegramEntry,
    resolveTelegramDebounceLane,
  };
}
