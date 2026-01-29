import type { Client } from "@buape/carbon";

import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  resolveChannelDelayMs,
  resolveSkipIfPeerRepliedMs,
} from "../../auto-reply/inbound-debounce.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { ReplyToMode } from "../../config/config.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import { processDiscordMessage } from "./message-handler.process.js";
import { resolveDiscordMessageText } from "./message-utils.js";

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type DiscordConfig = NonNullable<
  import("../../config/config.js").MoltbotConfig["channels"]
>["discord"];

export function createDiscordMessageHandler(params: {
  cfg: LoadedConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: Array<string | number>;
  allowFrom?: Array<string | number>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordMessageHandler {
  const groupPolicy = params.discordConfig?.groupPolicy ?? "open";
  const ackReactionScope = params.cfg.messages?.ackReactionScope ?? "group-mentions";
  const debounceMs = resolveInboundDebounceMs({ cfg: params.cfg, channel: "discord" });
  const channelDelayMs = resolveChannelDelayMs({ cfg: params.cfg, channel: "discord" });
  const skipIfPeerRepliedMs = resolveSkipIfPeerRepliedMs({ cfg: params.cfg });

  const debouncer = createInboundDebouncer<{ data: DiscordMessageEvent; client: Client }>({
    debounceMs,
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) return null;
      const channelId = message.channelId;
      if (!channelId) return null;
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) return false;
      if (message.attachments && message.attachments.length > 0) return false;
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      if (!baseText.trim()) return false;
      return !hasControlCommand(baseText, params.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        const ctx = await preflightDiscordMessage({
          ...params,
          ackReactionScope,
          groupPolicy,
          data: last.data,
          client: last.client,
        });
        if (!ctx) return;
        await processDiscordMessage(ctx);
        return;
      }
      const combinedBaseText = entries
        .map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false }))
        .filter(Boolean)
        .join("\n");
      const syntheticMessage = {
        ...last.data.message,
        content: combinedBaseText,
        attachments: [],
        message_snapshots: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
        messageSnapshots: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
        rawData: {
          ...(last.data.message as { rawData?: Record<string, unknown> }).rawData,
        },
      };
      const syntheticData: DiscordMessageEvent = {
        ...last.data,
        message: syntheticMessage,
      };
      const ctx = await preflightDiscordMessage({
        ...params,
        ackReactionScope,
        groupPolicy,
        data: syntheticData,
        client: last.client,
      });
      if (!ctx) return;
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.data.message?.id).filter(Boolean) as string[];
        if (ids.length > 0) {
          const ctxBatch = ctx as typeof ctx & {
            MessageSids?: string[];
            MessageSidFirst?: string;
            MessageSidLast?: string;
          };
          ctxBatch.MessageSids = ids;
          ctxBatch.MessageSidFirst = ids[0];
          ctxBatch.MessageSidLast = ids[ids.length - 1];
        }
      }
      await processDiscordMessage(ctx);
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const checkPeerReplied = async (data: DiscordMessageEvent, client: Client): Promise<boolean> => {
    if (skipIfPeerRepliedMs <= 0) return false;
    const channelId = data.message?.channelId;
    const triggerMessageId = data.message?.id;
    const triggerTimestamp = data.message?.timestamp;
    if (!channelId || !triggerMessageId || !triggerTimestamp) return false;

    try {
      // Fetch recent messages after the trigger
      const messages = (await client.rest.get(
        `/channels/${channelId}/messages?after=${triggerMessageId}&limit=10`,
      )) as
        | Array<{ id: string; author?: { bot?: boolean; id?: string }; timestamp: string }>
        | undefined;
      if (!Array.isArray(messages)) return false;

      const triggerTime = new Date(triggerTimestamp).getTime();
      const windowEnd = triggerTime + skipIfPeerRepliedMs;

      // Check if any bot (not us) replied within the window
      for (const msg of messages) {
        if (!msg.author?.bot) continue;
        // Skip our own bot's messages
        if (params.botUserId && msg.author?.id === params.botUserId) continue;
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime <= windowEnd) {
          params.runtime.log?.(
            `Skipping response: peer bot replied within ${skipIfPeerRepliedMs}ms window`,
          );
          return true;
        }
      }
      return false;
    } catch {
      // If we can't check, proceed anyway
      return false;
    }
  };

  return async (data, client) => {
    try {
      // Apply channel delay for multi-bot coordination
      if (channelDelayMs > 0) {
        await sleep(channelDelayMs);
        // Check if a peer bot already replied
        if (await checkPeerReplied(data, client)) {
          return; // Skip responding
        }
      }
      await debouncer.enqueue({ data, client });
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };
}
