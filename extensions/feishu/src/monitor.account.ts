// Feishu plugin module implements monitor.account behavior.
import * as crypto from "node:crypto";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv, HistoryEntry } from "../runtime-api.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import {
  handleFeishuMessage,
  parseFeishuMessageEvent,
  type FeishuMessageEvent,
  type FeishuBotAddedEvent,
} from "./bot.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import { createEventDispatcher } from "./client.js";
import { isRecord, readString } from "./comment-shared.js";
import { hasProcessedFeishuMessage, warmupDedupFromPluginState } from "./dedup.js";
import { createFeishuDurableIngress, type FeishuIngressLifecycle } from "./feishu-ingress.js";
import { applyBotIdentityState, startBotIdentityRecovery } from "./monitor.bot-identity.js";
import { createFeishuBotMenuHandler } from "./monitor.bot-menu-handler.js";
import { createFeishuDriveCommentNoticeHandler } from "./monitor.comment-notice-handler.js";
import type { FeishuStatusSink } from "./monitor.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { FeishuRetryableSyntheticEventError } from "./monitor.synthetic-error.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
import { createFeishuVcMeetingInvitedHandler } from "./monitor.vc-meeting-invited-handler.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu } from "./send.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import { createFeishuThreadBindingManager } from "./thread-bindings.js";
import type { FeishuChatType, ResolvedFeishuAccount } from "./types.js";

const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1_500;

export { FeishuRetryableSyntheticEventError };

export type FeishuReactionCreatedEvent = {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: { open_id?: string; user_id?: string };
  action_time?: string;
};

type FeishuReactionDeletedEvent = FeishuReactionCreatedEvent & {
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
  const senderUserId = event.user_id?.user_id;
  if (!emoji || !messageId || !senderId) {
    return null;
  }

  const { resolveFeishuAccount } = await import("./accounts.js");
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
      sender_id: {
        open_id: senderId,
        ...(senderUserId ? { user_id: senderUserId } : {}),
      },
      sender_type: "user",
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:${uuid()}`,
      typing_target_message_id: messageId,
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
  return value === "group" || value === "topic_group" || value === "private" || value === "p2p"
    ? value
    : undefined;
}

type RegisterEventHandlersContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  channelRuntime: PluginRuntime["channel"];
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  vcAutoJoin: boolean;
  /** Owning account signal; retrying handlers must propagate it. */
  abortSignal?: AbortSignal;
  /**
   * Optional status sink. When provided, the message handler will publish
   * `lastEventAt` on every inbound message for message recency. Transport
   * liveness is published by the transport layer.
   */
  statusSink?: FeishuStatusSink;
  resolveIngressLifecycle?: (data: unknown) => FeishuIngressLifecycle | undefined;
};

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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = readString(value);
    const trimmed = stringValue?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function readFeishuIdentityField(
  value: unknown,
  field: "open_id" | "user_id" | "union_id",
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return firstString(value[field]);
}

function parseFeishuCardActionEventPayload(value: unknown): FeishuCardActionEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = isRecord(value.operator) ? value.operator : {};
  const action = value.action;
  const context = isRecord(value.context) ? value.context : {};
  if (!isRecord(action)) {
    return null;
  }
  const operatorUserId = operator.user_id;
  const token = readString(value.token);
  const openId = firstString(
    operator.open_id,
    readFeishuIdentityField(operatorUserId, "open_id"),
    value.open_id,
    context.open_id,
  );
  const userId = firstString(
    operator.user_id,
    readFeishuIdentityField(operatorUserId, "user_id"),
    value.user_id,
    context.user_id,
  );
  const unionId = firstString(
    operator.union_id,
    readFeishuIdentityField(operatorUserId, "union_id"),
  );
  const tag = readString(action.tag);
  const actionValue = action.value;
  // Prefer context.open_message_id (original card message) over value.open_message_id
  // which may be a temporary card-action-c-* ID that is not a valid Feishu message ID.
  const openMessageId = firstString(context.open_message_id, value.open_message_id);
  const contextOpenId = firstString(context.open_id, openId);
  const contextUserId = firstString(context.user_id, userId);
  const chatId = firstString(context.chat_id, context.open_chat_id);
  if (!token || !openId || !tag || !isRecord(actionValue)) {
    return null;
  }
  return {
    operator: {
      open_id: openId,
      ...(userId ? { user_id: userId } : {}),
      ...(unionId ? { union_id: unionId } : {}),
    },
    token,
    action: {
      value: actionValue,
      tag,
    },
    ...(openMessageId ? { open_message_id: openMessageId } : {}),
    context: {
      ...(openMessageId ? { open_message_id: openMessageId } : {}),
      ...(contextOpenId ? { open_id: contextOpenId } : {}),
      ...(contextUserId ? { user_id: contextUserId } : {}),
      ...(chatId ? { chat_id: chatId } : {}),
    },
  };
}

function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: RegisterEventHandlersContext,
): void {
  const { cfg, accountId, channelRuntime, runtime, chatHistories, fireAndForget, abortSignal } =
    context;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const runFeishuHandler = async (params: { task: () => Promise<void>; errorMessage: string }) => {
    if (fireAndForget) {
      void params.task().catch((err: unknown) => {
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

  eventDispatcher.register({
    "im.message.receive_v1": createFeishuMessageReceiveHandler({
      cfg,
      channelRuntime,
      accountId,
      runtime,
      chatHistories,
      fireAndForget,
      handleMessage: handleFeishuMessage,
      resolveDebounceText: ({ event, botOpenId, botName }) =>
        parseFeishuMessageEvent(event, botOpenId, botName).content,
      hasProcessedMessage: hasProcessedFeishuMessage,
      getBotOpenId: (id) => botOpenIds.get(id),
      getBotName: (id) => botNames.get(id),
      resolveSequentialKey: getFeishuSequentialKey,
      resolveIngressLifecycle: context.resolveIngressLifecycle,
      ...(context.statusSink ? { statusSink: context.statusSink } : {}),
    }),
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {
      // Ignore p2p chat entry notifications — no action needed
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
    "drive.notice.comment_add_v1": createFeishuDriveCommentNoticeHandler({
      cfg,
      accountId,
      runtime,
      fireAndForget,
      abortSignal,
      resolveIngressLifecycle: context.resolveIngressLifecycle,
    }),
    "vc.bot.meeting_invited_v1": createFeishuVcMeetingInvitedHandler({
      cfg,
      accountId,
      runtime,
      fireAndForget,
      channelRuntime,
      autoJoin: context.vcAutoJoin,
    }),
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
            channelRuntime,
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
            channelRuntime,
            chatHistories,
            accountId,
          });
          await promise;
        },
      });
    },
    "application.bot.menu_v6": createFeishuBotMenuHandler({
      cfg,
      accountId,
      runtime,
      chatHistories,
      fireAndForget,
      channelRuntime,
    }),
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
          channelRuntime,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err: unknown) => {
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

type BotOpenIdSource =
  | {
      kind: "prefetched";
      botOpenId?: string;
      botName?: string;
      source?: "provider" | "cache";
    }
  | { kind: "fetch" };

type MonitorSingleAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  channelRuntime?: PluginRuntime["channel"];
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  botOpenIdSource?: BotOpenIdSource;
  fireAndForget?: boolean;
  /**
   * Optional status sink for Feishu channel health. When provided, it is
   * propagated to the event dispatcher for message recency and the transport
   * layer for lifecycle status.
   */
  statusSink?: FeishuStatusSink;
};

export async function monitorSingleAccount(params: MonitorSingleAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
  const botIdentity =
    botOpenIdSource.kind === "prefetched"
      ? {
          botOpenId: botOpenIdSource.botOpenId,
          botName: botOpenIdSource.botName,
          source: botOpenIdSource.source,
        }
      : await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
  const { botOpenId } = applyBotIdentityState(accountId, botIdentity);
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  if ((!botOpenId || botIdentity.source === "cache") && !abortSignal?.aborted) {
    startBotIdentityRecovery({
      account,
      accountId,
      runtime,
      abortSignal,
      currentSource: botIdentity.source,
    });
  }

  const connectionMode = account.config.connectionMode ?? "websocket";
  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }
  if (connectionMode === "webhook" && !account.encryptKey?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

  const warmupCount = await warmupDedupFromPluginState(accountId, log);
  if (warmupCount > 0) {
    log(`feishu[${accountId}]: dedup warmup loaded ${warmupCount} entries from plugin state`);
  }

  let threadBindingManager: ReturnType<typeof createFeishuThreadBindingManager> | null | undefined;
  try {
    const eventDispatcher = createEventDispatcher(account);
    // Minimal dispatcher doubles exercise handlers directly and intentionally
    // omit invoke; production SDK dispatchers always provide the receive seam.
    const durableIngress =
      typeof (eventDispatcher as { invoke?: unknown }).invoke === "function"
        ? createFeishuDurableIngress({
            accountId,
            dispatcher: eventDispatcher,
            ...(account.encryptKey ? { encryptKey: account.encryptKey } : {}),
            runtime: runtime ?? {},
          })
        : undefined;
    const durableEventDispatcher = durableIngress
      ? (Object.assign(Object.create(eventDispatcher), {
          invoke: durableIngress.invoke,
        }) as Lark.EventDispatcher)
      : eventDispatcher;
    const chatHistories = new Map<string, HistoryEntry[]>();
    threadBindingManager = createFeishuThreadBindingManager({ accountId, cfg });
    const channelRuntime = params.channelRuntime?.inbound
      ? params.channelRuntime
      : getFeishuRuntime().channel;

    registerEventHandlers(eventDispatcher, {
      cfg,
      accountId,
      channelRuntime,
      runtime,
      chatHistories,
      fireAndForget: params.fireAndForget ?? true,
      vcAutoJoin: account.config.vcAutoJoin === true,
      abortSignal,
      ...(durableIngress ? { resolveIngressLifecycle: durableIngress.resolveLifecycle } : {}),
      ...(params.statusSink ? { statusSink: params.statusSink } : {}),
    });

    durableIngress?.start();
    try {
      if (connectionMode === "webhook") {
        return await monitorWebhook({
          account,
          accountId,
          runtime,
          abortSignal,
          eventDispatcher: durableEventDispatcher,
          ...(params.statusSink ? { statusSink: params.statusSink } : {}),
        });
      }
      return await monitorWebSocket({
        account,
        accountId,
        runtime,
        abortSignal,
        eventDispatcher: durableEventDispatcher,
        ...(durableIngress ? { setSocketTerminator: durableIngress.setSocketTerminator } : {}),
        ...(params.statusSink ? { statusSink: params.statusSink } : {}),
      });
    } finally {
      await durableIngress?.stop();
    }
  } finally {
    threadBindingManager?.stop();
  }
}
