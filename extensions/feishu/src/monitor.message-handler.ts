import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { isMentionForwardRequest } from "./mention.js";
import {
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
} from "./processing-claims.js";
import { createSequentialQueue } from "./sequential-queue.js";
import type { FeishuChatType } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type FeishuMessageReceiveHandlerContext = {
  cfg: ClawdbotConfig;
  core: PluginRuntime;
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  handleMessage: (params: {
    cfg: ClawdbotConfig;
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
    runtime?: RuntimeEnv;
    chatHistories?: Map<string, HistoryEntry[]>;
    accountId?: string;
    processingClaimHeld?: boolean;
  }) => Promise<void>;
  resolveDebounceText: (params: {
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
  }) => string;
  hasProcessedMessage: (
    messageId: string | undefined | null,
    namespace: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  recordProcessedMessage: (
    messageId: string | undefined | null,
    namespace: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  getBotOpenId?: (accountId: string) => string | undefined;
  getBotName?: (accountId: string) => string | undefined;
  resolveSequentialKey?: (params: {
    accountId: string;
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
  }) => string;
};

function normalizeFeishuChatType(value: unknown): FeishuChatType | undefined {
  return value === "group" || value === "topic_group" || value === "private" || value === "p2p"
    ? value
    : undefined;
}

function parseFeishuMessageEventPayload(value: unknown): FeishuMessageEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const sender = value.sender;
  const message = value.message;
  if (!isRecord(sender) || !isRecord(message)) {
    return null;
  }
  const senderId = sender.sender_id;
  if (!isRecord(senderId)) {
    return null;
  }
  const messageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const chatType = normalizeFeishuChatType(message.chat_type);
  const messageType = readString(message.message_type);
  const content = readString(message.content);
  if (!messageId || !chatId || !chatType || !messageType || !content) {
    return null;
  }
  return value as FeishuMessageEvent;
}

function mergeFeishuDebounceMentions(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent["message"]["mentions"] | undefined {
  const merged = new Map<string, NonNullable<FeishuMessageEvent["message"]["mentions"]>[number]>();
  for (const entry of entries) {
    for (const mention of entry.message.mentions ?? []) {
      const stableId =
        mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
      const mentionName = mention.name?.trim();
      const mentionKey = mention.key?.trim();
      const fallback =
        mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
      const key = stableId || fallback;
      if (!key || merged.has(key)) {
        continue;
      }
      merged.set(key, mention);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function dedupeFeishuDebounceEntriesByDedupeKey(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent[] {
  const seen = new Set<string>();
  const deduped: FeishuMessageEvent[] = [];
  for (const entry of entries) {
    const dedupeKey = resolveFeishuMessageDedupeKey(entry);
    if (!dedupeKey) {
      deduped.push(entry);
      continue;
    }
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(entry);
  }
  return deduped;
}

function resolveFeishuDebounceMentions(params: {
  entries: FeishuMessageEvent[];
  botOpenId?: string;
}): FeishuMessageEvent["message"]["mentions"] | undefined {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMentionForwardRequest(entry, botOpenId)) {
      return mergeFeishuDebounceMentions([entry]);
    }
  }
  const merged = mergeFeishuDebounceMentions(entries);
  if (!merged) {
    return undefined;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return undefined;
  }
  const botMentions = merged.filter(
    (mention) => mention.id.open_id?.trim() === normalizedBotOpenId,
  );
  return botMentions.length > 0 ? botMentions : undefined;
}

export function createFeishuMessageReceiveHandler({
  cfg,
  core,
  accountId,
  runtime,
  chatHistories,
  fireAndForget,
  handleMessage,
  resolveDebounceText: resolveText,
  hasProcessedMessage,
  recordProcessedMessage,
  getBotOpenId = () => undefined,
  getBotName = () => undefined,
  resolveSequentialKey = ({ accountId, event }) =>
    `feishu:${accountId}:${event.message.chat_id?.trim() || "unknown"}`,
}: FeishuMessageReceiveHandlerContext): (data: unknown) => Promise<void> {
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu",
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createSequentialQueue({
    onTaskTimeout: (key, timeoutMs) => {
      log(
        `feishu[${accountId}]: per-chat task exceeded ${timeoutMs}ms cap (key=${key}); evicting from queue so later same-key messages can proceed (#70133)`,
      );
    },
  });

  const dispatchFeishuMessage = async (event: FeishuMessageEvent) => {
    const sequentialKey = resolveSequentialKey({
      accountId,
      event,
      botOpenId: getBotOpenId(accountId),
      botName: getBotName(accountId),
    });
    const task = () =>
      handleMessage({
        cfg,
        event,
        botOpenId: getBotOpenId(accountId),
        botName: getBotName(accountId),
        runtime,
        chatHistories,
        accountId,
        processingClaimHeld: true,
      });
    await enqueue(sequentialKey, task);
  };

  const resolveSenderDebounceId = (event: FeishuMessageEvent): string | undefined => {
    const senderId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || undefined;
  };

  const resolveDebounceText = (event: FeishuMessageEvent): string => {
    return resolveText({
      event,
      botOpenId: getBotOpenId(accountId),
      botName: getBotName(accountId),
    }).trim();
  };

  const recordSuppressedMessageIds = async (
    entries: FeishuMessageEvent[],
    dispatchDedupeKey?: string,
  ) => {
    const keepDedupeKey = dispatchDedupeKey?.trim();
    const suppressedIds = new Set(
      entries
        .map((entry) => resolveFeishuMessageDedupeKey(entry))
        .filter((id): id is string => Boolean(id) && (!keepDedupeKey || id !== keepDedupeKey)),
    );
    for (const messageId of suppressedIds) {
      try {
        await recordProcessedMessage(messageId, accountId, log);
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`,
        );
      }
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<FeishuMessageEvent>({
    debounceMs: inboundDebounceMs,
    buildKey: (event) => {
      const chatId = event.message.chat_id?.trim();
      const senderId = resolveSenderDebounceId(event);
      if (!chatId || !senderId) {
        return null;
      }
      const rootId = event.message.root_id?.trim();
      const threadKey = rootId ? `thread:${rootId}` : "chat";
      return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (event) => {
      if (event.message.message_type !== "text") {
        return false;
      }
      const text = resolveDebounceText(event);
      return Boolean(text) && !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await dispatchFeishuMessage(last);
        return;
      }
      const dedupedEntries = dedupeFeishuDebounceEntriesByDedupeKey(entries);
      const freshEntries: FeishuMessageEvent[] = [];
      for (const entry of dedupedEntries) {
        if (!(await hasProcessedMessage(resolveFeishuMessageDedupeKey(entry), accountId, log))) {
          freshEntries.push(entry);
        }
      }
      const dispatchEntry = freshEntries.at(-1);
      if (!dispatchEntry) {
        return;
      }
      await recordSuppressedMessageIds(
        dedupedEntries,
        resolveFeishuMessageDedupeKey(dispatchEntry),
      );
      const combinedText = freshEntries
        .map((entry) => resolveDebounceText(entry))
        .filter(Boolean)
        .join("\n");
      const mergedMentions = resolveFeishuDebounceMentions({
        entries: freshEntries,
        botOpenId: getBotOpenId(accountId),
      });
      await dispatchFeishuMessage({
        ...dispatchEntry,
        message: {
          ...dispatchEntry.message,
          ...(combinedText.trim()
            ? {
                message_type: "text",
                content: JSON.stringify({ text: combinedText }),
              }
            : {}),
          mentions: mergedMentions ?? dispatchEntry.message.mentions,
        },
      });
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        releaseFeishuMessageProcessing(resolveFeishuMessageDedupeKey(entry), accountId);
      }
      error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
    },
  });

  return async (data) => {
    const event = parseFeishuMessageEventPayload(data);
    if (!event) {
      error(`feishu[${accountId}]: ignoring malformed message event payload`);
      return;
    }
    const messageId = event.message?.message_id?.trim();
    const messageDedupeKey = resolveFeishuMessageDedupeKey(event);
    if (!tryBeginFeishuMessageProcessing(messageDedupeKey, accountId)) {
      log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
      return;
    }
    const processMessage = async () => {
      await inboundDebouncer.enqueue(event);
    };
    if (fireAndForget) {
      void processMessage().catch((err) => {
        releaseFeishuMessageProcessing(messageDedupeKey, accountId);
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      });
      return;
    }
    try {
      await processMessage();
    } catch (err) {
      releaseFeishuMessageProcessing(messageDedupeKey, accountId);
      error(`feishu[${accountId}]: error handling message: ${String(err)}`);
    }
  };
}
