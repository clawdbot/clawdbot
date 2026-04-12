import * as crypto from "crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import {
  handleFeishuMessage,
  parseFeishuMessageEvent,
  type FeishuMessageEvent,
  type FeishuBotAddedEvent,
} from "./bot.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";
import { createEventDispatcher } from "./client.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { isRecord, readString } from "./comment-shared.js";
import {
  hasProcessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
  warmupDedupFromDisk,
} from "./dedup.js";
import { isMentionForwardRequest } from "./mention.js";
import { applyBotIdentityState, startBotIdentityRecovery } from "./monitor.bot-identity.js";
import { parseFeishuDriveCommentNoticeEventPayload } from "./monitor.comment.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu } from "./send.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import { createSequentialQueue } from "./sequential-queue.js";
import { createFeishuThreadBindingManager } from "./thread-bindings.js";
import type { FeishuChatType, ResolvedFeishuAccount } from "./types.js";

const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1_500;

export type FeishuReactionCreatedEvent = {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: { open_id?: string };
  action_time?: string;
};

export type FeishuReactionDeletedEvent = FeishuReactionCreatedEvent & {
  reaction_id?: string;
};

type ResolveReactionSyntheticEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuReactionCreatedEvent;
  botOpenId?: string;
  fetchMessage?: typeof getMessageFeishu;
  verificationTimeoutMs?: number;
  logger?: (message: string) => void;
  uuid?: () => string;
  action?: "created" | "deleted";
};

export async function resolveReactionSyntheticEvent(
  params: ResolveReactionSyntheticEventParams,
): Promise<FeishuMessageEvent | null> {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    fetchMessage = getMessageFeishu,
    verificationTimeoutMs = FEISHU_REACTION_VERIFY_TIMEOUT_MS,
    logger,
    uuid = () => crypto.randomUUID(),
    action = "created",
  } = params;

  const emoji = event.reaction_type?.emoji_type;
  const messageId = event.message_id;
  const senderId = event.user_id?.open_id;
  if (!emoji || !messageId || !senderId) {
    return null;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const reactionNotifications = account.config.reactionNotifications ?? "own";
  if (reactionNotifications === "off") {
    return null;
  }

  if (event.operator_type === "app" || senderId === botOpenId) {
    return null;
  }

  if (emoji === "Typing") {
    return null;
  }

  if (reactionNotifications === "own" && !botOpenId) {
    logger?.(
      `feishu[${accountId}]: bot open_id unavailable, skipping reaction ${emoji} on ${messageId}`,
    );
    return null;
  }

  const reactedMsg = await raceWithTimeoutAndAbort(fetchMessage({ cfg, messageId, accountId }), {
    timeoutMs: verificationTimeoutMs,
  })
    .then((result) => (result.status === "resolved" ? result.value : null))
    .catch(() => null);
  const isBotMessage = reactedMsg?.senderType === "app" || reactedMsg?.senderOpenId === botOpenId;
  if (!reactedMsg || (reactionNotifications === "own" && !isBotMessage)) {
    logger?.(
      `feishu[${accountId}]: ignoring reaction on non-bot/unverified message ${messageId} ` +
        `(sender: ${reactedMsg?.senderOpenId ?? "unknown"})`,
    );
    return null;
  }

  const fallbackChatType = reactedMsg.chatType;
  const normalizedEventChatType = normalizeFeishuChatType(event.chat_type);
  const resolvedChatType = normalizedEventChatType ?? fallbackChatType;
  if (!resolvedChatType) {
    logger?.(
      `feishu[${accountId}]: skipping reaction ${emoji} on ${messageId} without chat type context`,
    );
    return null;
  }

  const syntheticChatIdRaw = event.chat_id ?? reactedMsg.chatId;
  const syntheticChatId = syntheticChatIdRaw?.trim() ? syntheticChatIdRaw : `p2p:${senderId}`;
  const syntheticChatType: FeishuChatType = resolvedChatType;
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:${uuid()}`,
      chat_id: syntheticChatId,
      chat_type: syntheticChatType,
      message_type: "text",
      content: JSON.stringify({
        text:
          action === "deleted"
            ? `[removed reaction ${emoji} from message ${messageId}]`
            : `[reacted with ${emoji} to message ${messageId}]`,
      }),
    },
  };
}

function normalizeFeishuChatType(value: unknown): FeishuChatType | undefined {
  return value === "group" || value === "private" || value === "p2p" ? value : undefined;
}

type RegisterEventHandlersContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
};

type FeishuBotMenuEvent = {
  event_key?: string;
  timestamp?: string | number;
  operator?: {
    operator_name?: string;
    operator_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
};

function readStringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
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

function parseFeishuBotAddedEventPayload(value: unknown): FeishuBotAddedEvent | null {
  if (!isRecord(value) || !readString(value.chat_id) || !isRecord(value.operator_id)) {
    return null;
  }
  return value as FeishuBotAddedEvent;
}

function parseFeishuBotRemovedChatId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return readString(value.chat_id) ?? null;
}

function parseFeishuBotMenuEvent(value: unknown): FeishuBotMenuEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = value.operator;
  if (operator !== undefined && !isRecord(operator)) {
    return null;
  }
  return {
    event_key: readString(value.event_key),
    timestamp: readStringOrNumber(value.timestamp),
    operator: operator
      ? {
          operator_name: readString(operator.operator_name),
          operator_id: isRecord(operator.operator_id)
            ? {
                open_id: readString(operator.operator_id.open_id),
                user_id: readString(operator.operator_id.user_id),
                union_id: readString(operator.operator_id.union_id),
              }
            : undefined,
        }
      : undefined,
  };
}

function parseFeishuCardActionEventPayload(value: unknown): FeishuCardActionEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = value.operator;
  const action = value.action;
  const context = value.context;
  if (!isRecord(operator) || !isRecord(action) || !isRecord(context)) {
    return null;
  }
  const token = readString(value.token);
  const openId = readString(operator.open_id);
  const userId = readString(operator.user_id);
  const unionId = readString(operator.union_id);
  const tag = readString(action.tag);
  const actionValue = action.value;
  const contextOpenId = readString(context.open_id);
  const contextUserId = readString(context.user_id);
  const chatId = readString(context.chat_id);
  if (
    !token ||
    !openId ||
    !userId ||
    !unionId ||
    !tag ||
    !isRecord(actionValue) ||
    !contextOpenId ||
    !contextUserId ||
    !chatId
  ) {
    return null;
  }
  return {
    operator: {
      open_id: openId,
      user_id: userId,
      union_id: unionId,
    },
    token,
    action: {
      value: actionValue,
      tag,
    },
    context: {
      open_id: contextOpenId,
      user_id: contextUserId,
      chat_id: chatId,
    },
  };
}

function buildCommentNoticeQueueKey(event: {
  notice_meta?: {
    file_type?: string;
    file_token?: string;
  };
}): string {
  const fileType = event.notice_meta?.file_type?.trim() || "unknown";
  const fileToken = event.notice_meta?.file_token?.trim() || "unknown";
  return `comment-doc:${fileType}:${fileToken}`;
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
  if (merged.size === 0) {
    return undefined;
  }
  return Array.from(merged.values());
}

function dedupeFeishuDebounceEntriesByMessageId(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent[] {
  const seen = new Set<string>();
  const deduped: FeishuMessageEvent[] = [];
  for (const entry of entries) {
    const messageId = entry.message.message_id?.trim();
    if (!messageId) {
      deduped.push(entry);
      continue;
    }
    if (seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
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
      // Keep mention-forward semantics scoped to a single source message.
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

function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: RegisterEventHandlersContext,
): void {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const core = getFeishuRuntime();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu",
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  // Keep normal Feishu traffic FIFO per chat while allowing explicit out-of-band
  // commands like /btw and /stop to bypass the busy main-chat lane.
  const enqueue = createSequentialQueue();
  const runFeishuHandler = async (params: { task: () => Promise<void>; errorMessage: string }) => {
    if (fireAndForget) {
      void params.task().catch((err) => {
        error(`${params.errorMessage}: ${String(err)}`);
      });
      return;
    }
    try {
      await params.task();
    } catch (err) {
      error(`${params.errorMessage}: ${String(err)}`);
    }
  };
  const dispatchFeishuMessage = async (event: FeishuMessageEvent) => {
    const sequentialKey = getFeishuSequentialKey({
      accountId,
      event,
      botOpenId: botOpenIds.get(accountId),
      botName: botNames.get(accountId),
    });
    const task = () =>
      handleFeishuMessage({
        cfg,
        event,
        botOpenId: botOpenIds.get(accountId),
        botName: botNames.get(accountId),
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
    const botOpenId = botOpenIds.get(accountId);
    const parsed = parseFeishuMessageEvent(event, botOpenId, botNames.get(accountId));
    return parsed.content.trim();
  };
  const recordSuppressedMessageIds = async (
    entries: FeishuMessageEvent[],
    dispatchMessageId?: string,
  ) => {
    const keepMessageId = dispatchMessageId?.trim();
    const suppressedIds = new Set(
      entries
        .map((entry) => entry.message.message_id?.trim())
        .filter((id): id is string => Boolean(id) && (!keepMessageId || id !== keepMessageId)),
    );
    if (suppressedIds.size === 0) {
      return;
    }
    for (const messageId of suppressedIds) {
      try {
        await recordProcessedFeishuMessage(messageId, accountId, log);
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`,
        );
      }
    }
  };
  const isMessageAlreadyProcessed = async (entry: FeishuMessageEvent): Promise<boolean> => {
    return await hasProcessedFeishuMessage(entry.message.message_id, accountId, log);
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
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg);
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
      const dedupedEntries = dedupeFeishuDebounceEntriesByMessageId(entries);
      const freshEntries: FeishuMessageEvent[] = [];
      for (const entry of dedupedEntries) {
        if (!(await isMessageAlreadyProcessed(entry))) {
          freshEntries.push(entry);
        }
      }
      const dispatchEntry = freshEntries.at(-1);
      if (!dispatchEntry) {
        return;
      }
      await recordSuppressedMessageIds(dedupedEntries, dispatchEntry.message.message_id);
      const combinedText = freshEntries
        .map((entry) => resolveDebounceText(entry))
        .filter(Boolean)
        .join("\n");
      const mergedMentions = resolveFeishuDebounceMentions({
        entries: freshEntries,
        botOpenId: botOpenIds.get(accountId),
      });
      if (!combinedText.trim()) {
        await dispatchFeishuMessage({
          ...dispatchEntry,
          message: {
            ...dispatchEntry.message,
            mentions: mergedMentions ?? dispatchEntry.message.mentions,
          },
        });
        return;
      }
      await dispatchFeishuMessage({
        ...dispatchEntry,
        message: {
          ...dispatchEntry.message,
          message_type: "text",
          content: JSON.stringify({ text: combinedText }),
          mentions: mergedMentions ?? dispatchEntry.message.mentions,
        },
      });
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        releaseFeishuMessageProcessing(entry.message.message_id, accountId);
      }
      error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
    },
  });

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      const event = parseFeishuMessageEventPayload(data);
      if (!event) {
        error(`feishu[${accountId}]: ignoring malformed message event payload`);
        return;
      }
      const messageId = event.message?.message_id?.trim();
      if (!tryBeginFeishuMessageProcessing(messageId, accountId)) {
        log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
        return;
      }
      const processMessage = async () => {
        await inboundDebouncer.enqueue(event);
      };
      if (fireAndForget) {
        void processMessage().catch((err) => {
          releaseFeishuMessageProcessing(messageId, accountId);
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        });
        return;
      }
      try {
        await processMessage();
      } catch (err) {
        releaseFeishuMessageProcessing(messageId, accountId);
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = parseFeishuBotAddedEventPayload(data);
        if (!event) {
          return;
        }
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const chatId = parseFeishuBotRemovedChatId(data);
        if (!chatId) {
          return;
        }
        log(`feishu[${accountId}]: bot removed from chat ${chatId}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
    "drive.notice.comment_add_v1": async (data: unknown) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling drive comment notice`,
        task: async () => {
          const event = parseFeishuDriveCommentNoticeEventPayload(data);
          if (!event) {
            error(`feishu[${accountId}]: ignoring malformed drive comment notice payload`);
            return;
          }
          const eventId = event.event_id?.trim();
          const syntheticMessageId = eventId ? `drive-comment:${eventId}` : undefined;
          if (
            syntheticMessageId &&
            (await hasProcessedFeishuMessage(syntheticMessageId, accountId, log))
          ) {
            log(`feishu[${accountId}]: dropping duplicate comment event ${syntheticMessageId}`);
            return;
          }
          if (
            syntheticMessageId &&
            !tryBeginFeishuMessageProcessing(syntheticMessageId, accountId)
          ) {
            log(`feishu[${accountId}]: dropping in-flight comment event ${syntheticMessageId}`);
            return;
          }
          log(
            `feishu[${accountId}]: received drive comment notice ` +
              `event=${event.event_id ?? "unknown"} ` +
              `type=${event.notice_meta?.notice_type ?? "unknown"} ` +
              `file=${event.notice_meta?.file_type ?? "unknown"}:${event.notice_meta?.file_token ?? "unknown"} ` +
              `comment=${event.comment_id ?? "unknown"} ` +
              `reply=${event.reply_id ?? "none"} ` +
              `from=${event.notice_meta?.from_user_id?.open_id ?? "unknown"} ` +
              `mentioned=${event.is_mentioned === true ? "yes" : "no"}`,
          );
          try {
            await enqueue(buildCommentNoticeQueueKey(event), async () => {
              await handleFeishuCommentEvent({
                cfg,
                accountId,
                event,
                botOpenId: botOpenIds.get(accountId),
                runtime,
              });
            });
            if (syntheticMessageId) {
              await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
            }
          } finally {
            if (syntheticMessageId) {
              releaseFeishuMessageProcessing(syntheticMessageId, accountId);
            }
          }
        },
      });
    },
    "im.message.reaction.created_v1": async (data) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction event`,
        task: async () => {
          const event = data as FeishuReactionCreatedEvent;
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event,
            botOpenId: myBotId,
            logger: log,
          });
          if (!syntheticEvent) {
            return;
          }
          const promise = handleFeishuMessage({
            cfg,
            event: syntheticEvent,
            botOpenId: myBotId,
            botName: botNames.get(accountId),
            runtime,
            chatHistories,
            accountId,
          });
          await promise;
        },
      });
    },
    "im.message.reaction.deleted_v1": async (data) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction removal event`,
        task: async () => {
          const event = data as FeishuReactionDeletedEvent;
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event,
            botOpenId: myBotId,
            logger: log,
            action: "deleted",
          });
          if (!syntheticEvent) {
            return;
          }
          const promise = handleFeishuMessage({
            cfg,
            event: syntheticEvent,
            botOpenId: myBotId,
            botName: botNames.get(accountId),
            runtime,
            chatHistories,
            accountId,
          });
          await promise;
        },
      });
    },
    "application.bot.menu_v6": async (data) => {
      try {
        const event = parseFeishuBotMenuEvent(data);
        if (!event) {
          return;
        }
        const operatorOpenId = event.operator?.operator_id?.open_id?.trim();
        const eventKey = event.event_key?.trim();
        if (!operatorOpenId || !eventKey) {
          return;
        }
        const syntheticEvent: FeishuMessageEvent = {
          sender: {
            sender_id: {
              open_id: operatorOpenId,
              user_id: event.operator?.operator_id?.user_id,
              union_id: event.operator?.operator_id?.union_id,
            },
            sender_type: "user",
          },
          message: {
            message_id: `bot-menu:${eventKey}:${event.timestamp ?? Date.now()}`,
            chat_id: `p2p:${operatorOpenId}`,
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({
              text: `/menu ${eventKey}`,
            }),
          },
        };
        const syntheticMessageId = syntheticEvent.message.message_id;
        if (await hasProcessedFeishuMessage(syntheticMessageId, accountId, log)) {
          log(`feishu[${accountId}]: dropping duplicate bot-menu event for ${syntheticMessageId}`);
          return;
        }
        if (!tryBeginFeishuMessageProcessing(syntheticMessageId, accountId)) {
          log(`feishu[${accountId}]: dropping in-flight bot-menu event for ${syntheticMessageId}`);
          return;
        }
        const handleLegacyMenu = () =>
          handleFeishuMessage({
            cfg,
            event: syntheticEvent,
            botOpenId: botOpenIds.get(accountId),
            botName: botNames.get(accountId),
            runtime,
            chatHistories,
            accountId,
            processingClaimHeld: true,
          });

        const promise = maybeHandleFeishuQuickActionMenu({
          cfg,
          eventKey,
          operatorOpenId,
          runtime,
          accountId,
        })
          .then(async (handledMenu) => {
            if (handledMenu) {
              await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
              releaseFeishuMessageProcessing(syntheticMessageId, accountId);
              return;
            }
            return await handleLegacyMenu();
          })
          .catch((err) => {
            releaseFeishuMessageProcessing(syntheticMessageId, accountId);
            throw err;
          });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
          });
          return;
        }
        await promise;
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
      }
    },
    "card.action.trigger": async (data: unknown) => {
      try {
        const event = parseFeishuCardActionEventPayload(data);
        if (!event) {
          error(`feishu[${accountId}]: ignoring malformed card action payload`);
          return;
        }
        const promise = handleFeishuCardAction({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
      }
    },
  });
}

export type BotOpenIdSource =
  | { kind: "prefetched"; botOpenId?: string; botName?: string }
  | { kind: "fetch" };

export type MonitorSingleAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  botOpenIdSource?: BotOpenIdSource;
};

export async function monitorSingleAccount(params: MonitorSingleAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
  const botIdentity =
    botOpenIdSource.kind === "prefetched"
      ? { botOpenId: botOpenIdSource.botOpenId, botName: botOpenIdSource.botName }
      : await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
  const { botOpenId } = applyBotIdentityState(accountId, botIdentity);
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  if (!botOpenId && !abortSignal?.aborted) {
    startBotIdentityRecovery({ account, accountId, runtime, abortSignal });
  }

  const connectionMode = account.config.connectionMode ?? "websocket";
  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }
  if (connectionMode === "webhook" && !account.encryptKey?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

  const warmupCount = await warmupDedupFromDisk(accountId, log);
  if (warmupCount > 0) {
    log(`feishu[${accountId}]: dedup warmup loaded ${warmupCount} entries from disk`);
  }

  let threadBindingManager: ReturnType<typeof createFeishuThreadBindingManager> | null = null;
  try {
    const eventDispatcher = createEventDispatcher(account);
    const chatHistories = new Map<string, HistoryEntry[]>();
    threadBindingManager = createFeishuThreadBindingManager({ accountId, cfg });

    registerEventHandlers(eventDispatcher, {
      cfg,
      accountId,
      runtime,
      chatHistories,
      fireAndForget: true,
    });

    if (connectionMode === "webhook") {
      return await monitorWebhook({ account, accountId, runtime, abortSignal, eventDispatcher });
    }
    return await monitorWebSocket({ account, accountId, runtime, abortSignal, eventDispatcher });
  } finally {
    threadBindingManager?.stop();
  }
}
