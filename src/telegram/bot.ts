// @ts-nocheck
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, Message } from "grammy";
import { Bot, InputFile, webhookCallback } from "grammy";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveAckReaction,
  resolveEffectiveMessagesConfig,
} from "../agents/identity.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  buildCommandText,
  listNativeCommandSpecsForConfig,
  normalizeCommandBody,
} from "../auto-reply/commands-registry.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  formatLocationText,
  type NormalizedLocation,
  toLocationContext,
} from "../channels/location.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
} from "../config/commands.js";
import type { ClawdbotConfig, ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateLastRoute,
} from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { isGifMedia } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { resolveTelegramFetch } from "./fetch.js";
import { markdownToTelegramHtml } from "./format.js";
import {
  readTelegramAllowFromStore,
  upsertTelegramPairingRequest,
} from "./pairing-store.js";
import { resolveTelegramVoiceSend } from "./voice.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

// Media group aggregation - Telegram sends multi-image messages as separate updates
// with a shared media_group_id. We buffer them and process as a single message after a short delay.
const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;

type TelegramMessage = Message.CommonMessage;

type TelegramStreamMode = "off" | "partial" | "block";

type MediaGroupEntry = {
  messages: Array<{
    msg: TelegramMessage;
    ctx: TelegramContext;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

type TelegramUpdateKeyContext = {
  update?: {
    update_id?: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  };
  update_id?: number;
  message?: TelegramMessage;
  callbackQuery?: { id?: string; message?: TelegramMessage };
};

const resolveTelegramUpdateId = (ctx: TelegramUpdateKeyContext) =>
  ctx.update?.update_id ?? ctx.update_id;

const buildTelegramUpdateKey = (ctx: TelegramUpdateKeyContext) => {
  const updateId = resolveTelegramUpdateId(ctx);
  if (typeof updateId === "number") return `update:${updateId}`;
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) return `callback:${callbackId}`;
  const msg =
    ctx.message ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.callbackQuery?.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (typeof chatId !== "undefined" && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return undefined;
};

const createTelegramUpdateDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
    maxSize: RECENT_TELEGRAM_UPDATE_MAX,
  });

/** Telegram Location object */
interface TelegramLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
}

/** Telegram Venue object */
interface TelegramVenue {
  location: TelegramLocation;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}

type TelegramContext = {
  message: TelegramMessage;
  me?: { username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

export type TelegramBotOptions = {
  token: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
  config?: ClawdbotConfig;
  updateOffset?: {
    lastUpdateId?: number | null;
    onUpdateId?: (updateId: number) => void | Promise<void>;
  };
};

export function getTelegramSequentialKey(ctx: {
  chat?: { id?: number };
  message?: TelegramMessage;
  update?: {
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    callback_query?: { message?: TelegramMessage };
  };
}): string {
  const msg =
    ctx.message ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const isForum = (msg?.chat as { is_forum?: boolean } | undefined)?.is_forum;
  const threadId = resolveTelegramForumThreadId({
    isForum,
    messageThreadId: msg?.message_thread_id,
  });
  if (typeof chatId === "number") {
    return threadId != null
      ? `telegram:${chatId}:topic:${threadId}`
      : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}

function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  if (params.isForum && params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId ?? undefined;
}

export function createTelegramBot(opts: TelegramBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const fetchImpl = resolveTelegramFetch(opts.proxyFetch);
  const isBun = "Bun" in globalThis || Boolean(process?.versions?.bun);
  const shouldProvideFetch = Boolean(opts.proxyFetch) || isBun;
  const client: ApiClientOptions | undefined = fetchImpl
    ? shouldProvideFetch
      ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
      : undefined
    : undefined;

  const bot = new Bot(opts.token, client ? { client } : undefined);
  bot.api.config.use(apiThrottler());
  bot.use(sequentialize(getTelegramSequentialKey));

  const recentUpdates = createTelegramUpdateDedupe();
  let lastUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number"
      ? opts.updateOffset.lastUpdateId
      : null;

  const recordUpdateId = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId !== "number") return;
    if (lastUpdateId !== null && updateId <= lastUpdateId) return;
    lastUpdateId = updateId;
    void opts.updateOffset?.onUpdateId?.(updateId);
  };

  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId === "number" && lastUpdateId !== null) {
      if (updateId <= lastUpdateId) return true;
    }
    const key = buildTelegramUpdateKey(ctx);
    const skipped = recentUpdates.check(key);
    if (skipped && key && shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
    return skipped;
  };

  bot.use(async (ctx, next) => {
    await next();
    recordUpdateId(ctx);
  });

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const telegramCfg = account.config;
  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ??
    telegramCfg.groupAllowFrom ??
    (telegramCfg.allowFrom && telegramCfg.allowFrom.length > 0
      ? telegramCfg.allowFrom
      : undefined) ??
    (opts.allowFrom && opts.allowFrom.length > 0 ? opts.allowFrom : undefined);
  const normalizeAllowFrom = (list?: Array<string | number>) => {
    const entries = (list ?? [])
      .map((value) => String(value).trim())
      .filter(Boolean);
    const hasWildcard = entries.includes("*");
    const normalized = entries
      .filter((value) => value !== "*")
      .map((value) => value.replace(/^(telegram|tg):/i, ""));
    const normalizedLower = normalized.map((value) => value.toLowerCase());
    return {
      entries: normalized,
      entriesLower: normalizedLower,
      hasWildcard,
      hasEntries: entries.length > 0,
    };
  };
  const firstDefined = <T>(...values: Array<T | undefined>) => {
    for (const value of values) {
      if (typeof value !== "undefined") return value;
    }
    return undefined;
  };
  const isSenderAllowed = (params: {
    allow: ReturnType<typeof normalizeAllowFrom>;
    senderId?: string;
    senderUsername?: string;
  }) => {
    const { allow, senderId, senderUsername } = params;
    if (!allow.hasEntries) return true;
    if (allow.hasWildcard) return true;
    if (senderId && allow.entries.includes(senderId)) return true;
    const username = senderUsername?.toLowerCase();
    if (!username) return false;
    return allow.entriesLower.some(
      (entry) => entry === username || entry === `@${username}`,
    );
  };
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "first";
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  let botHasTopicsEnabled: boolean | undefined;
  const resolveBotTopicsEnabled = async (ctx?: TelegramContext) => {
    const fromCtx = ctx?.me as { has_topics_enabled?: boolean } | undefined;
    if (typeof fromCtx?.has_topics_enabled === "boolean") {
      botHasTopicsEnabled = fromCtx.has_topics_enabled;
      return botHasTopicsEnabled;
    }
    if (typeof botHasTopicsEnabled === "boolean") return botHasTopicsEnabled;
    try {
      const me = (await bot.api.getMe()) as { has_topics_enabled?: boolean };
      botHasTopicsEnabled = Boolean(me?.has_topics_enabled);
    } catch (err) {
      logVerbose(`telegram getMe failed: ${String(err)}`);
      botHasTopicsEnabled = false;
    }
    return botHasTopicsEnabled;
  };
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") return false;
      if (entry?.groupActivation === "mention") return true;
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const resolveTelegramGroupConfig = (
    chatId: string | number,
    messageThreadId?: number,
  ) => {
    const groups = telegramCfg.groups;
    if (!groups) return { groupConfig: undefined, topicConfig: undefined };
    const groupKey = String(chatId);
    const groupConfig = groups[groupKey] ?? groups["*"];
    const topicConfig =
      messageThreadId != null
        ? groupConfig?.topics?.[String(messageThreadId)]
        : undefined;
    return { groupConfig, topicConfig };
  };

  const processMessage = async (
    primaryCtx: TelegramContext,
    allMedia: Array<{ path: string; contentType?: string }>,
    storeAllowFrom: string[],
    options?: { forceWasMentioned?: boolean; messageIdOverride?: string },
  ) => {
    const msg = primaryCtx.message;
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "inbound",
    });
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const messageThreadId = (msg as { message_thread_id?: number })
      .message_thread_id;
    const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
    const resolvedThreadId = resolveTelegramForumThreadId({
      isForum,
      messageThreadId,
    });
    const { groupConfig, topicConfig } = resolveTelegramGroupConfig(
      chatId,
      resolvedThreadId,
    );
    const peerId = isGroup
      ? buildTelegramGroupPeerId(chatId, resolvedThreadId)
      : String(chatId);
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: peerId,
      },
    });
    const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
    const effectiveDmAllow = normalizeAllowFrom([
      ...(allowFrom ?? []),
      ...storeAllowFrom,
    ]);
    const groupAllowOverride = firstDefined(
      topicConfig?.allowFrom,
      groupConfig?.allowFrom,
    );
    const effectiveGroupAllow = normalizeAllowFrom([
      ...(groupAllowOverride ?? groupAllowFrom ?? []),
      ...storeAllowFrom,
    ]);
    const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

    if (isGroup && groupConfig?.enabled === false) {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return;
    }
    if (isGroup && topicConfig?.enabled === false) {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return;
    }

    const sendTyping = async () => {
      try {
        await bot.api.sendChatAction(
          chatId,
          "typing",
          buildTelegramThreadParams(resolvedThreadId),
        );
      } catch (err) {
        logVerbose(
          `telegram typing cue failed for chat ${chatId}: ${String(err)}`,
        );
      }
    };

    // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled"
    if (!isGroup) {
      if (dmPolicy === "disabled") return;

      if (dmPolicy !== "open") {
        const candidate = String(chatId);
        const senderUsername = msg.from?.username ?? "";
        const allowed =
          effectiveDmAllow.hasWildcard ||
          (effectiveDmAllow.hasEntries &&
            isSenderAllowed({
              allow: effectiveDmAllow,
              senderId: candidate,
              senderUsername,
            }));
        if (!allowed) {
          if (dmPolicy === "pairing") {
            try {
              const from = msg.from as
                | {
                    first_name?: string;
                    last_name?: string;
                    username?: string;
                    id?: number;
                  }
                | undefined;
              const telegramUserId = from?.id ? String(from.id) : candidate;
              const { code, created } = await upsertTelegramPairingRequest({
                chatId: candidate,
                username: from?.username,
                firstName: from?.first_name,
                lastName: from?.last_name,
              });
              if (created) {
                logger.info(
                  {
                    chatId: candidate,
                    username: from?.username,
                    firstName: from?.first_name,
                    lastName: from?.last_name,
                  },
                  "telegram pairing request",
                );
                await bot.api.sendMessage(
                  chatId,
                  [
                    "Clawdbot: access not configured.",
                    "",
                    `Your Telegram user id: ${telegramUserId}`,
                    "",
                    `Pairing code: ${code}`,
                    "",
                    "Ask the bot owner to approve with:",
                    "clawdbot pairing approve telegram <code>",
                  ].join("\n"),
                );
              }
            } catch (err) {
              logVerbose(
                `telegram pairing reply failed for chat ${chatId}: ${String(err)}`,
              );
            }
          } else {
            logVerbose(
              `Blocked unauthorized telegram sender ${candidate} (dmPolicy=${dmPolicy})`,
            );
          }
          return;
        }
      }
    }

    const botUsername = primaryCtx.me?.username?.toLowerCase();
    const senderId = msg.from?.id ? String(msg.from.id) : "";
    const senderUsername = msg.from?.username ?? "";
    if (isGroup && hasGroupAllowOverride) {
      const allowed = isSenderAllowed({
        allow: effectiveGroupAllow,
        senderId,
        senderUsername,
      });
      if (!allowed) {
        logVerbose(
          `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
        );
        return;
      }
    }
    const commandAuthorized = isSenderAllowed({
      allow: isGroup ? effectiveGroupAllow : effectiveDmAllow,
      senderId,
      senderUsername,
    });
    const computedWasMentioned =
      (Boolean(botUsername) && hasBotMention(msg, botUsername)) ||
      matchesMentionPatterns(msg.text ?? msg.caption ?? "", mentionRegexes);
    const wasMentioned =
      options?.forceWasMentioned === true ? true : computedWasMentioned;
    const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
      (ent) => ent.type === "mention",
    );
    const activationOverride = resolveGroupActivation({
      chatId,
      messageThreadId: resolvedThreadId,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
    });
    const baseRequireMention = resolveGroupRequireMention(chatId);
    const requireMention = firstDefined(
      activationOverride,
      topicConfig?.requireMention,
      groupConfig?.requireMention,
      baseRequireMention,
    );
    const shouldBypassMention =
      isGroup &&
      requireMention &&
      !wasMentioned &&
      !hasAnyMention &&
      commandAuthorized &&
      hasControlCommand(msg.text ?? msg.caption ?? "", cfg, { botUsername });
    const effectiveWasMentioned = wasMentioned || shouldBypassMention;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    if (isGroup && requireMention && canDetectMention) {
      if (!wasMentioned && !shouldBypassMention) {
        logger.info({ chatId, reason: "no-mention" }, "skipping group message");
        return;
      }
    }

    // ACK reactions
    const ackReaction = resolveAckReaction(cfg, route.agentId);
    const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return !isGroup;
      if (ackReactionScope === "group-all") return isGroup;
      if (ackReactionScope === "group-mentions") {
        if (!isGroup) return false;
        if (!requireMention) return false;
        if (!canDetectMention) return false;
        return wasMentioned || shouldBypassMention;
      }
      return false;
    };
    const api = bot.api as unknown as {
      setMessageReaction?: (
        chatId: number | string,
        messageId: number,
        reactions: Array<{ type: "emoji"; emoji: string }>,
      ) => Promise<void>;
    };
    const reactionApi =
      typeof api.setMessageReaction === "function"
        ? api.setMessageReaction.bind(api)
        : null;
    const ackReactionPromise =
      shouldAckReaction() && msg.message_id && reactionApi
        ? reactionApi(chatId, msg.message_id, [
            { type: "emoji", emoji: ackReaction },
          ]).then(
            () => true,
            (err) => {
              logVerbose(
                `telegram react failed for chat ${chatId}: ${String(err)}`,
              );
              return false;
            },
          )
        : null;

    let placeholder = "";
    if (msg.photo) placeholder = "<media:image>";
    else if (msg.video) placeholder = "<media:video>";
    else if (msg.audio || msg.voice) placeholder = "<media:audio>";
    else if (msg.document) placeholder = "<media:document>";

    const replyTarget = describeReplyTarget(msg);
    const locationData = extractTelegramLocation(msg);
    const locationText = locationData
      ? formatLocationText(locationData)
      : undefined;
    const rawText = (msg.text ?? msg.caption ?? "").trim();
    let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
    if (!rawBody) rawBody = placeholder;
    if (!rawBody && allMedia.length === 0) return;

    let bodyText = rawBody;
    if (!bodyText && allMedia.length > 0) {
      bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
    }

    const replySuffix = replyTarget
      ? `\n\n[Replying to ${replyTarget.sender}${
          replyTarget.id ? ` id:${replyTarget.id}` : ""
        }]\n${replyTarget.body}\n[/Replying]`
      : "";
    const groupLabel = isGroup
      ? buildGroupLabel(msg, chatId, resolvedThreadId)
      : undefined;
    const body = formatAgentEnvelope({
      channel: "Telegram",
      from: isGroup
        ? buildGroupFromLabel(msg, chatId, senderId, resolvedThreadId)
        : buildSenderLabel(msg, senderId || chatId),
      timestamp: msg.date ? msg.date * 1000 : undefined,
      body: `${bodyText}${replySuffix}`,
    });
    let combinedBody = body;
    const historyKey = isGroup
      ? buildTelegramGroupPeerId(chatId, resolvedThreadId)
      : undefined;
    if (isGroup && historyKey && historyLimit > 0) {
      combinedBody = buildHistoryContextFromMap({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
        entry: {
          sender: buildSenderLabel(msg, senderId || chatId),
          body: rawBody,
          timestamp: msg.date ? msg.date * 1000 : undefined,
          messageId:
            typeof msg.message_id === "number"
              ? String(msg.message_id)
              : undefined,
        },
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatAgentEnvelope({
            channel: "Telegram",
            from: groupLabel ?? `group:${chatId}`,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
          }),
      });
    }

    const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
    const systemPromptParts = [
      groupConfig?.systemPrompt?.trim() || null,
      topicConfig?.systemPrompt?.trim() || null,
    ].filter((entry): entry is string => Boolean(entry));
    const groupSystemPrompt =
      systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
    const commandBody = normalizeCommandBody(rawBody, { botUsername });
    const ctxPayload = {
      Body: combinedBody,
      RawBody: rawBody,
      CommandBody: commandBody,
      From: isGroup
        ? buildTelegramGroupFrom(chatId, resolvedThreadId)
        : `telegram:${chatId}`,
      To: `telegram:${chatId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
      GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
      SenderName: buildSenderName(msg),
      SenderId: senderId || undefined,
      SenderUsername: senderUsername || undefined,
      Provider: "telegram",
      Surface: "telegram",
      MessageSid: options?.messageIdOverride ?? String(msg.message_id),
      ReplyToId: replyTarget?.id,
      ReplyToBody: replyTarget?.body,
      ReplyToSender: replyTarget?.sender,
      Timestamp: msg.date ? msg.date * 1000 : undefined,
      WasMentioned: isGroup ? effectiveWasMentioned : undefined,
      MediaPath: allMedia[0]?.path,
      MediaType: allMedia[0]?.contentType,
      MediaUrl: allMedia[0]?.path,
      MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
      MediaUrls: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
      MediaTypes:
        allMedia.length > 0
          ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
          : undefined,
      ...(locationData ? toLocationContext(locationData) : undefined),
      CommandAuthorized: commandAuthorized,
      MessageThreadId: resolvedThreadId,
      IsForum: isForum,
      // Originating channel for reply routing.
      OriginatingChannel: "telegram" as const,
      OriginatingTo: `telegram:${chatId}`,
    };

    if (replyTarget && shouldLogVerbose()) {
      const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
      logVerbose(
        `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
      );
    }

    if (!isGroup) {
      const sessionCfg = cfg.session;
      const storePath = resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        channel: "telegram",
        to: String(chatId),
        accountId: route.accountId,
      });
    }

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      const mediaInfo =
        allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
      const topicInfo =
        resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
      logVerbose(
        `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`,
      );
    }

    const isPrivateChat = msg.chat.type === "private";
    const draftMaxChars = Math.min(textLimit, 4096);
    const canStreamDraft =
      streamMode !== "off" &&
      isPrivateChat &&
      typeof resolvedThreadId === "number" &&
      (await resolveBotTopicsEnabled(primaryCtx));
    const draftStream = canStreamDraft
      ? createTelegramDraftStream({
          api: bot.api,
          chatId,
          draftId: msg.message_id || Date.now(),
          maxChars: draftMaxChars,
          messageThreadId: resolvedThreadId,
          log: logVerbose,
          warn: logVerbose,
        })
      : undefined;
    const draftChunking =
      draftStream && streamMode === "block"
        ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
        : undefined;
    const draftChunker = draftChunking
      ? new EmbeddedBlockChunker(draftChunking)
      : undefined;
    let lastPartialText = "";
    let draftText = "";
    const updateDraftFromPartial = (text?: string) => {
      if (!draftStream || !text) return;
      if (text === lastPartialText) return;
      if (streamMode === "partial") {
        lastPartialText = text;
        draftStream.update(text);
        return;
      }
      let delta = text;
      if (text.startsWith(lastPartialText)) {
        delta = text.slice(lastPartialText.length);
      } else {
        // Streaming buffer reset (or non-monotonic stream). Start fresh.
        draftChunker?.reset();
        draftText = "";
      }
      lastPartialText = text;
      if (!delta) return;
      if (!draftChunker) {
        draftText = text;
        draftStream.update(draftText);
        return;
      }
      draftChunker.append(delta);
      draftChunker.drain({
        force: false,
        emit: (chunk) => {
          draftText += chunk;
          draftStream.update(draftText);
        },
      });
    };
    const flushDraft = async () => {
      if (!draftStream) return;
      if (draftChunker?.hasBuffered()) {
        draftChunker.drain({
          force: true,
          emit: (chunk) => {
            draftText += chunk;
          },
        });
        draftChunker.reset();
        if (draftText) draftStream.update(draftText);
      }
      await draftStream.flush();
    };

    const disableBlockStreaming =
      Boolean(draftStream) ||
      (typeof telegramCfg.blockStreaming === "boolean"
        ? !telegramCfg.blockStreaming
        : undefined);

    let didSendReply = false;
    const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
          .responsePrefix,
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            await flushDraft();
            draftStream?.stop();
          }
          await deliverReplies({
            replies: [payload],
            chatId: String(chatId),
            token: opts.token,
            runtime,
            bot,
            replyToMode,
            textLimit,
            messageThreadId: resolvedThreadId,
          });
          didSendReply = true;
        },
        onError: (err, info) => {
          runtime.error?.(
            danger(`telegram ${info.kind} reply failed: ${String(err)}`),
          );
        },
        onReplyStart: sendTyping,
      },
      replyOptions: {
        skillFilter,
        onPartialReply: draftStream
          ? (payload) => updateDraftFromPartial(payload.text)
          : undefined,
        onReasoningStream: draftStream
          ? (payload) => {
              if (payload.text) draftStream.update(payload.text);
            }
          : undefined,
        disableBlockStreaming,
      },
    });
    draftStream?.stop();
    if (!queuedFinal) {
      if (isGroup && historyKey && historyLimit > 0 && didSendReply) {
        clearHistoryEntries({ historyMap: groupHistories, historyKey });
      }
      return;
    }
    if (
      removeAckAfterReply &&
      ackReactionPromise &&
      msg.message_id &&
      reactionApi
    ) {
      void ackReactionPromise.then((didAck) => {
        if (!didAck) return;
        reactionApi(chatId, msg.message_id, []).catch((err) => {
          logVerbose(
            `telegram: failed to remove ack reaction from ${chatId}/${msg.message_id}: ${String(err)}`,
          );
        });
      });
    }
    if (isGroup && historyKey && historyLimit > 0 && didSendReply) {
      clearHistoryEntries({ historyMap: groupHistories, historyKey });
    }
  };

  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg)
    : [];
  if (nativeCommands.length > 0) {
    const api = bot.api as unknown as {
      setMyCommands?: (
        commands: Array<{ command: string; description: string }>,
      ) => Promise<unknown>;
    };
    if (typeof api.setMyCommands === "function") {
      api
        .setMyCommands(
          nativeCommands.map((command) => ({
            command: command.name,
            description: command.description,
          })),
        )
        .catch((err) => {
          runtime.error?.(
            danger(`telegram setMyCommands failed: ${String(err)}`),
          );
        });
    } else {
      logVerbose("telegram: setMyCommands unavailable; skipping registration");
    }

    if (
      typeof (bot as unknown as { command?: unknown }).command !== "function"
    ) {
      logVerbose("telegram: bot.command unavailable; skipping native handlers");
    } else {
      for (const command of nativeCommands) {
        bot.command(command.name, async (ctx) => {
          const msg = ctx.message;
          if (!msg) return;
          if (shouldSkipUpdate(ctx)) return;
          const chatId = msg.chat.id;
          const isGroup =
            msg.chat.type === "group" || msg.chat.type === "supergroup";
          const messageThreadId = (msg as { message_thread_id?: number })
            .message_thread_id;
          const isForum =
            (msg.chat as { is_forum?: boolean }).is_forum === true;
          const resolvedThreadId = resolveTelegramForumThreadId({
            isForum,
            messageThreadId,
          });
          const storeAllowFrom = await readTelegramAllowFromStore().catch(
            () => [],
          );
          const { groupConfig, topicConfig } = resolveTelegramGroupConfig(
            chatId,
            resolvedThreadId,
          );
          const groupAllowOverride = firstDefined(
            topicConfig?.allowFrom,
            groupConfig?.allowFrom,
          );
          const effectiveGroupAllow = normalizeAllowFrom([
            ...(groupAllowOverride ?? groupAllowFrom ?? []),
            ...storeAllowFrom,
          ]);
          const hasGroupAllowOverride =
            typeof groupAllowOverride !== "undefined";

          if (isGroup && groupConfig?.enabled === false) {
            await bot.api.sendMessage(chatId, "This group is disabled.");
            return;
          }
          if (isGroup && topicConfig?.enabled === false) {
            await bot.api.sendMessage(chatId, "This topic is disabled.");
            return;
          }
          if (isGroup && hasGroupAllowOverride) {
            const senderId = msg.from?.id;
            const senderUsername = msg.from?.username ?? "";
            if (
              senderId == null ||
              !isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId: String(senderId),
                senderUsername,
              })
            ) {
              await bot.api.sendMessage(
                chatId,
                "You are not authorized to use this command.",
              );
              return;
            }
          }

          if (isGroup && useAccessGroups) {
            const groupPolicy = telegramCfg.groupPolicy ?? "open";
            if (groupPolicy === "disabled") {
              await bot.api.sendMessage(
                chatId,
                "Telegram group commands are disabled.",
              );
              return;
            }
            if (groupPolicy === "allowlist") {
              const senderId = msg.from?.id;
              if (senderId == null) {
                await bot.api.sendMessage(
                  chatId,
                  "You are not authorized to use this command.",
                );
                return;
              }
              const senderUsername = msg.from?.username ?? "";
              if (
                !isSenderAllowed({
                  allow: effectiveGroupAllow,
                  senderId: String(senderId),
                  senderUsername,
                })
              ) {
                await bot.api.sendMessage(
                  chatId,
                  "You are not authorized to use this command.",
                );
                return;
              }
            }
            const groupAllowlist = resolveGroupPolicy(chatId);
            if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
              await bot.api.sendMessage(chatId, "This group is not allowed.");
              return;
            }
          }

          const allowFromList = Array.isArray(allowFrom)
            ? allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
            : [];
          const senderId = msg.from?.id ? String(msg.from.id) : "";
          const senderUsername = msg.from?.username ?? "";
          const commandAuthorized =
            allowFromList.length === 0 ||
            allowFromList.includes("*") ||
            (senderId && allowFromList.includes(senderId)) ||
            (senderId && allowFromList.includes(`telegram:${senderId}`)) ||
            (senderUsername &&
              allowFromList.some(
                (entry) =>
                  entry.toLowerCase() === senderUsername.toLowerCase() ||
                  entry.toLowerCase() === `@${senderUsername.toLowerCase()}`,
              ));
          if (!commandAuthorized) {
            await bot.api.sendMessage(
              chatId,
              "You are not authorized to use this command.",
            );
            return;
          }

          const prompt = buildCommandText(command.name, ctx.match ?? "");
          const route = resolveAgentRoute({
            cfg,
            channel: "telegram",
            accountId: account.accountId,
            peer: {
              kind: isGroup ? "group" : "dm",
              id: isGroup
                ? buildTelegramGroupPeerId(chatId, resolvedThreadId)
                : String(chatId),
            },
          });
          const skillFilter = firstDefined(
            topicConfig?.skills,
            groupConfig?.skills,
          );
          const systemPromptParts = [
            groupConfig?.systemPrompt?.trim() || null,
            topicConfig?.systemPrompt?.trim() || null,
          ].filter((entry): entry is string => Boolean(entry));
          const groupSystemPrompt =
            systemPromptParts.length > 0
              ? systemPromptParts.join("\n\n")
              : undefined;
          const ctxPayload = {
            Body: prompt,
            From: isGroup
              ? buildTelegramGroupFrom(chatId, resolvedThreadId)
              : `telegram:${chatId}`,
            To: `slash:${senderId || chatId}`,
            ChatType: isGroup ? "group" : "direct",
            GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
            GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
            SenderName: buildSenderName(msg),
            SenderId: senderId || undefined,
            SenderUsername: senderUsername || undefined,
            Surface: "telegram",
            MessageSid: String(msg.message_id),
            Timestamp: msg.date ? msg.date * 1000 : undefined,
            WasMentioned: true,
            CommandAuthorized: commandAuthorized,
            CommandSource: "native" as const,
            SessionKey: `telegram:slash:${senderId || chatId}`,
            CommandTargetSessionKey: route.sessionKey,
            MessageThreadId: resolvedThreadId,
            IsForum: isForum,
          };

          const disableBlockStreaming =
            typeof telegramCfg.blockStreaming === "boolean"
              ? !telegramCfg.blockStreaming
              : undefined;

          await dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
                .responsePrefix,
              deliver: async (payload) => {
                await deliverReplies({
                  replies: [payload],
                  chatId: String(chatId),
                  token: opts.token,
                  runtime,
                  bot,
                  replyToMode,
                  textLimit,
                  messageThreadId: resolvedThreadId,
                });
              },
              onError: (err, info) => {
                runtime.error?.(
                  danger(
                    `telegram slash ${info.kind} reply failed: ${String(err)}`,
                  ),
                );
              },
            },
            replyOptions: {
              skillFilter,
              disableBlockStreaming,
            },
          });
        });
      }
    }
  } else if (nativeDisabledExplicit) {
    const api = bot.api as unknown as {
      setMyCommands?: (commands: []) => Promise<unknown>;
    };
    if (typeof api.setMyCommands === "function") {
      api.setMyCommands([]).catch((err) => {
        runtime.error?.(
          danger(`telegram clear commands failed: ${String(err)}`),
        );
      });
    } else {
      logVerbose("telegram: setMyCommands unavailable; skipping clear");
    }
  }

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) return;
    if (shouldSkipUpdate(ctx)) return;
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) return;

      const syntheticMessage: TelegramMessage = {
        ...callbackMessage,
        from: callback.from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const getFile =
        typeof ctx.getFile === "function"
          ? ctx.getFile.bind(ctx)
          : async () => ({});
      await processMessage(
        { message: syntheticMessage, me: ctx.me, getFile },
        [],
        storeAllowFrom,
        { forceWasMentioned: true, messageIdOverride: callback.id },
      );
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    } finally {
      await bot.api.answerCallbackQuery(callback.id).catch(() => {});
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;
      if (shouldSkipUpdate(ctx)) return;

      const chatId = msg.chat.id;
      const isGroup =
        msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = (msg as { message_thread_id?: number })
        .message_thread_id;
      const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(
        chatId,
        resolvedThreadId,
      );
      const groupAllowOverride = firstDefined(
        topicConfig?.allowFrom,
        groupConfig?.allowFrom,
      );
      const effectiveGroupAllow = normalizeAllowFrom([
        ...(groupAllowOverride ?? groupAllowFrom ?? []),
        ...storeAllowFrom,
      ]);
      const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (hasGroupAllowOverride) {
          const senderId = msg.from?.id;
          const senderUsername = msg.from?.username ?? "";
          const allowed =
            senderId != null &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId ?? "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        // Group policy filtering: controls how group messages are handled
        // - "open": groups bypass allowFrom, only mention-gating applies
        // - "disabled": block all group messages entirely
        // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
        const groupPolicy = telegramCfg.groupPolicy ?? "open";
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          // For allowlist mode, the sender (msg.from.id) must be in allowFrom
          const senderId = msg.from?.id;
          if (senderId == null) {
            logVerbose(
              `Blocked telegram group message (no sender ID, groupPolicy: allowlist)`,
            );
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          const senderUsername = msg.from?.username ?? "";
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            })
          ) {
            logVerbose(
              `Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`,
            );
            return;
          }
        }

        // Group allowlist based on configured group IDs.
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: msg.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = (msg as { media_group_id?: string }).media_group_id;
      if (mediaGroupId) {
        const existing = mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.messages.push({ msg, ctx });
          existing.timer = setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(existing);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, MEDIA_GROUP_TIMEOUT_MS);
        } else {
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              mediaGroupProcessing = mediaGroupProcessing
                .then(async () => {
                  await processMediaGroup(entry);
                })
                .catch(() => undefined);
              await mediaGroupProcessing;
            }, MEDIA_GROUP_TIMEOUT_MS),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(
          ctx,
          mediaMaxBytes,
          opts.token,
          opts.proxyFetch,
        );
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await bot.api
            .sendMessage(
              chatId,
              `⚠️ File too large. Maximum size is ${limitMb}MB.`,
              { reply_to_message_id: msg.message_id },
            )
            .catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }
      const allMedia = media
        ? [{ path: media.path, contentType: media.contentType }]
        : [];
      await processMessage(ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find(
        (m) => m.msg.caption || m.msg.text,
      );
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: Array<{ path: string; contentType?: string }> = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(
          ctx,
          mediaMaxBytes,
          opts.token,
          opts.proxyFetch,
        );
        if (media) {
          allMedia.push({ path: media.path, contentType: media.contentType });
        }
      }

      const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  return bot;
}

export function createTelegramWebhookCallback(
  bot: Bot,
  path = "/telegram-webhook",
) {
  return { path, handler: webhookCallback(bot, "http") };
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  replyToMode: ReplyToMode;
  textLimit: number;
  messageThreadId?: number;
}) {
  const {
    replies,
    chatId,
    runtime,
    bot,
    replyToMode,
    textLimit,
    messageThreadId,
  } = params;
  const threadParams = buildTelegramThreadParams(messageThreadId);
  let hasReplied = false;
  for (const reply of replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    const replyToId =
      replyToMode === "off"
        ? undefined
        : resolveTelegramReplyId(reply.replyToId);
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    if (mediaList.length === 0) {
      for (const chunk of chunkMarkdownText(reply.text || "", textLimit)) {
        await sendTelegramText(bot, chatId, chunk, runtime, {
          replyToMessageId:
            replyToId && (replyToMode === "all" || !hasReplied)
              ? replyToId
              : undefined,
          messageThreadId,
        });
        if (replyToId && !hasReplied) {
          hasReplied = true;
        }
      }
      continue;
    }
    // media with optional caption on first item
    let first = true;
    for (const mediaUrl of mediaList) {
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const isGif = isGifMedia({
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
      const file = new InputFile(media.buffer, fileName);
      const caption = first ? (reply.text ?? undefined) : undefined;
      first = false;
      const replyToMessageId =
        replyToId && (replyToMode === "all" || !hasReplied)
          ? replyToId
          : undefined;
      const mediaParams: Record<string, unknown> = {
        caption,
        reply_to_message_id: replyToMessageId,
      };
      if (threadParams) {
        mediaParams.message_thread_id = threadParams.message_thread_id;
      }
      if (isGif) {
        await bot.api.sendAnimation(chatId, file, {
          ...mediaParams,
        });
      } else if (kind === "image") {
        await bot.api.sendPhoto(chatId, file, {
          ...mediaParams,
        });
      } else if (kind === "video") {
        await bot.api.sendVideo(chatId, file, {
          ...mediaParams,
        });
      } else if (kind === "audio") {
        const { useVoice } = resolveTelegramVoiceSend({
          wantsVoice: reply.audioAsVoice === true, // default false (backward compatible)
          contentType: media.contentType,
          fileName,
          logFallback: logVerbose,
        });
        if (useVoice) {
          // Voice message - displays as round playable bubble (opt-in via [[audio_as_voice]])
          await bot.api.sendVoice(chatId, file, {
            ...mediaParams,
          });
        } else {
          // Audio file - displays with metadata (title, duration) - DEFAULT
          await bot.api.sendAudio(chatId, file, {
            ...mediaParams,
          });
        }
      } else {
        await bot.api.sendDocument(chatId, file, {
          ...mediaParams,
        });
      }
      if (replyToId && !hasReplied) {
        hasReplied = true;
      }
    }
  }
}

function buildTelegramThreadParams(messageThreadId?: number) {
  return messageThreadId != null
    ? { message_thread_id: messageThreadId }
    : undefined;
}

function resolveTelegramStreamMode(
  telegramCfg: ClawdbotConfig["telegram"],
): TelegramStreamMode {
  const raw = telegramCfg?.streamMode?.trim().toLowerCase();
  if (raw === "off" || raw === "partial" || raw === "block") return raw;
  return "partial";
}

function buildTelegramGroupPeerId(
  chatId: number | string,
  messageThreadId?: number,
) {
  return messageThreadId != null
    ? `${chatId}:topic:${messageThreadId}`
    : String(chatId);
}

function buildTelegramGroupFrom(
  chatId: number | string,
  messageThreadId?: number,
) {
  return messageThreadId != null
    ? `group:${chatId}:topic:${messageThreadId}`
    : `group:${chatId}`;
}

function buildSenderName(msg: TelegramMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || msg.from?.username;
  return name || undefined;
}

function buildSenderLabel(msg: TelegramMessage, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : undefined;
  const fallbackId =
    normalizedSenderId ??
    (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) return `${label} ${idPart}`;
  if (label) return label;
  return idPart ?? "id:unknown";
}

function buildGroupLabel(
  msg: TelegramMessage,
  chatId: number | string,
  messageThreadId?: number,
) {
  const title = msg.chat?.title;
  const topicSuffix =
    messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) return `${title} id:${chatId}${topicSuffix}`;
  return `group:${chatId}${topicSuffix}`;
}

function buildGroupFromLabel(
  msg: TelegramMessage,
  chatId: number | string,
  senderId?: number | string,
  messageThreadId?: number,
) {
  const groupLabel = buildGroupLabel(msg, chatId, messageThreadId);
  const senderLabel = buildSenderLabel(msg, senderId);
  return `${groupLabel} from ${senderLabel}`;
}

function hasBotMention(msg: TelegramMessage, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) return true;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") continue;
    const slice = (msg.text ?? msg.caption ?? "").slice(
      ent.offset,
      ent.offset + ent.length,
    );
    if (slice.toLowerCase() === `@${botUsername}`) return true;
  }
  return false;
}

function resolveTelegramReplyId(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{ path: string; contentType?: string; placeholder: string } | null> {
  const msg = ctx.message;
  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.document ??
    msg.audio ??
    msg.voice;
  if (!m?.file_id) return null;
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "fetch is not available; set channels.telegram.proxy in config",
    );
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const fetched = await fetchRemoteMedia({
    url,
    fetchImpl,
    filePathHint: file.file_path,
  });
  const saved = await saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    maxBytes,
  );
  let placeholder = "<media:document>";
  if (msg.photo) placeholder = "<media:image>";
  else if (msg.video) placeholder = "<media:video>";
  else if (msg.audio || msg.voice) placeholder = "<media:audio>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}

async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: { replyToMessageId?: number; messageThreadId?: number },
): Promise<number | undefined> {
  const threadParams = buildTelegramThreadParams(opts?.messageThreadId);
  const baseParams: Record<string, unknown> = {
    reply_to_message_id: opts?.replyToMessageId,
  };
  if (threadParams) {
    baseParams.message_thread_id = threadParams.message_thread_id;
  }
  const htmlText = markdownToTelegramHtml(text);
  try {
    const res = await bot.api.sendMessage(chatId, htmlText, {
      parse_mode: "HTML",
      ...baseParams,
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(
        `telegram HTML parse failed; retrying without formatting: ${errText}`,
      );
      const res = await bot.api.sendMessage(chatId, text, {
        ...baseParams,
      });
      return res.message_id;
    }
    throw err;
  }
}

function describeReplyTarget(msg: TelegramMessage) {
  const reply = msg.reply_to_message;
  if (!reply) return null;
  const replyBody = (reply.text ?? reply.caption ?? "").trim();
  let body = replyBody;
  if (!body) {
    if (reply.photo) body = "<media:image>";
    else if (reply.video) body = "<media:video>";
    else if (reply.audio || reply.voice) body = "<media:audio>";
    else if (reply.document) body = "<media:document>";
    else {
      const locationData = extractTelegramLocation(reply);
      if (locationData) body = formatLocationText(locationData);
    }
  }
  if (!body) return null;
  const sender = buildSenderName(reply);
  const senderLabel = sender ? `${sender}` : "unknown sender";
  return {
    id: reply.message_id ? String(reply.message_id) : undefined,
    sender: senderLabel,
    body,
  };
}

function extractTelegramLocation(
  msg: TelegramMessage,
): NormalizedLocation | null {
  const msgWithLocation = msg as {
    location?: TelegramLocation;
    venue?: TelegramVenue;
  };
  const { venue, location } = msgWithLocation;

  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }

  if (location) {
    const isLive =
      typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }

  return null;
}
