// @ts-nocheck
import { Buffer } from "node:buffer";

import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, Message } from "grammy";
import { Bot, InputFile, webhookCallback } from "grammy";
import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { TypingController } from "../auto-reply/reply/typing.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveProviderGroupPolicy,
  resolveProviderGroupRequireMention,
} from "../config/group-policy.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { detectMime, isGifMedia } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

// Media group aggregation - Telegram sends multi-image messages as separate updates
// with a shared media_group_id. We buffer them and process as a single message after a short delay.
const MEDIA_GROUP_TIMEOUT_MS = 500;

type TelegramMessage = Message.CommonMessage;

type MediaGroupEntry = {
  messages: Array<{
    msg: TelegramMessage;
    ctx: TelegramContext;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

type TelegramContext = {
  message: TelegramMessage;
  me?: { username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

export type TelegramBotOptions = {
  token: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
};

export function createTelegramBot(opts: TelegramBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const client: ApiClientOptions | undefined = opts.proxyFetch
    ? { fetch: opts.proxyFetch as unknown as ApiClientOptions["fetch"] }
    : undefined;

  const bot = new Bot(opts.token, { client });
  bot.api.config.use(apiThrottler());

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();

  const cfg = loadConfig();
  const textLimit = resolveTextChunkLimit(cfg, "telegram");
  const allowFrom = opts.allowFrom ?? cfg.telegram?.allowFrom;
  const replyToMode = opts.replyToMode ?? cfg.telegram?.replyToMode ?? "off";
  const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.telegram?.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const mentionRegexes = buildMentionRegexes(cfg);
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveProviderGroupPolicy({
      cfg,
      surface: "telegram",
      groupId: String(chatId),
    });
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveProviderGroupRequireMention({
      cfg,
      surface: "telegram",
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });

  const processMessage = async (
    primaryCtx: TelegramContext,
    allMedia: Array<{ path: string; contentType?: string }>,
  ) => {
    const msg = primaryCtx.message;
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    const sendTyping = async () => {
      try {
        await bot.api.sendChatAction(chatId, "typing");
      } catch (err) {
        logVerbose(
          `telegram typing cue failed for chat ${chatId}: ${String(err)}`,
        );
      }
    };

    // allowFrom for direct chats
    if (!isGroup && Array.isArray(allowFrom) && allowFrom.length > 0) {
      const candidate = String(chatId);
      const allowed = allowFrom.map(String);
      const allowedWithPrefix = allowFrom.map((v) => `telegram:${String(v)}`);
      const permitted =
        allowed.includes(candidate) ||
        allowedWithPrefix.includes(`telegram:${candidate}`) ||
        allowed.includes("*");
      if (!permitted) {
        logVerbose(
          `Blocked unauthorized telegram sender ${candidate} (not in allowFrom)`,
        );
        return;
      }
    }

    const botUsername = primaryCtx.me?.username?.toLowerCase();
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
    const wasMentioned =
      (Boolean(botUsername) && hasBotMention(msg, botUsername)) ||
      matchesMentionPatterns(msg.text ?? msg.caption ?? "", mentionRegexes);
    const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
      (ent) => ent.type === "mention",
    );
    const requireMention = resolveGroupRequireMention(chatId);
    const shouldBypassMention =
      isGroup &&
      requireMention &&
      !wasMentioned &&
      !hasAnyMention &&
      commandAuthorized &&
      hasControlCommand(msg.text ?? msg.caption ?? "");
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    if (isGroup && requireMention && canDetectMention) {
      if (!wasMentioned && !shouldBypassMention) {
        logger.info({ chatId, reason: "no-mention" }, "skipping group message");
        return;
      }
    }

    // ACK reactions
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
    if (shouldAckReaction() && msg.message_id) {
      const api = bot.api as unknown as {
        setMessageReaction?: (
          chatId: number | string,
          messageId: number,
          reactions: Array<{ type: "emoji"; emoji: string }>,
        ) => Promise<void>;
      };
      if (typeof api.setMessageReaction === "function") {
        api
          .setMessageReaction(chatId, msg.message_id, [
            { type: "emoji", emoji: ackReaction },
          ])
          .catch((err) => {
            logVerbose(
              `telegram react failed for chat ${chatId}: ${String(err)}`,
            );
          });
      }
    }

    let placeholder = "";
    if (msg.photo) placeholder = "<media:image>";
    else if (msg.video) placeholder = "<media:video>";
    else if (msg.audio || msg.voice) placeholder = "<media:audio>";
    else if (msg.document) placeholder = "<media:document>";

    const replyTarget = describeReplyTarget(msg);
    const rawBody = (msg.text ?? msg.caption ?? placeholder).trim();
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
    const body = formatAgentEnvelope({
      surface: "Telegram",
      from: isGroup
        ? buildGroupLabel(msg, chatId)
        : buildSenderLabel(msg, chatId),
      timestamp: msg.date ? msg.date * 1000 : undefined,
      body: `${bodyText}${replySuffix}`,
    });

    const ctxPayload = {
      Body: body,
      From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
      To: `telegram:${chatId}`,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
      SenderName: buildSenderName(msg),
      SenderId: senderId || undefined,
      SenderUsername: senderUsername || undefined,
      Surface: "telegram",
      MessageSid: String(msg.message_id),
      ReplyToId: replyTarget?.id,
      ReplyToBody: replyTarget?.body,
      ReplyToSender: replyTarget?.sender,
      Timestamp: msg.date ? msg.date * 1000 : undefined,
      WasMentioned: isGroup ? wasMentioned : undefined,
      MediaPath: allMedia[0]?.path,
      MediaType: allMedia[0]?.contentType,
      MediaUrl: allMedia[0]?.path,
      MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
      MediaUrls: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
      MediaTypes:
        allMedia.length > 0
          ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
          : undefined,
      CommandAuthorized: commandAuthorized,
    };

    if (replyTarget && shouldLogVerbose()) {
      const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
      logVerbose(
        `telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`,
      );
    }

    if (!isGroup) {
      const sessionCfg = cfg.session;
      const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
      const storePath = resolveStorePath(sessionCfg?.store);
      await updateLastRoute({
        storePath,
        sessionKey: mainKey,
        channel: "telegram",
        to: String(chatId),
      });
    }

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      const mediaInfo =
        allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
      logVerbose(
        `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo} preview="${preview}"`,
      );
    }

    let typingController: TypingController | undefined;
    const dispatcher = createReplyDispatcher({
      responsePrefix: cfg.messages?.responsePrefix,
      deliver: async (payload) => {
        await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
        });
      },
      onIdle: () => {
        typingController?.markDispatchIdle();
      },
      onError: (err, info) => {
        runtime.error?.(
          danger(`telegram ${info.kind} reply failed: ${String(err)}`),
        );
      },
    });

    const { queuedFinal } = await dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        onReplyStart: sendTyping,
        onTypingController: (typing) => {
          typingController = typing;
        },
      },
    });
    typingController?.markDispatchIdle();
    if (!queuedFinal) return;
  };

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;

      const chatId = msg.chat.id;
      const isGroup =
        msg.chat.type === "group" || msg.chat.type === "supergroup";

      // Group policy check - skip disallowed groups early
      if (isGroup) {
        const groupPolicy = resolveGroupPolicy(chatId);
        if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
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
            await processMediaGroup(existing);
          }, MEDIA_GROUP_TIMEOUT_MS);
        } else {
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              await processMediaGroup(entry);
            }, MEDIA_GROUP_TIMEOUT_MS),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      const media = await resolveMedia(
        ctx,
        mediaMaxBytes,
        opts.token,
        opts.proxyFetch,
      );
      const allMedia = media
        ? [{ path: media.path, contentType: media.contentType }]
        : [];
      await processMessage(ctx, allMedia);
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

      await processMessage(primaryEntry.ctx, allMedia);
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
}) {
  const { replies, chatId, runtime, bot, replyToMode, textLimit } = params;
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
      for (const chunk of chunkText(reply.text || "", textLimit)) {
        await sendTelegramText(bot, chatId, chunk, runtime, {
          replyToMessageId:
            replyToId && (replyToMode === "all" || !hasReplied)
              ? replyToId
              : undefined,
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
      if (isGif) {
        await bot.api.sendAnimation(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
        });
      } else if (kind === "image") {
        await bot.api.sendPhoto(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
        });
      } else if (kind === "video") {
        await bot.api.sendVideo(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
        });
      } else if (kind === "audio") {
        await bot.api.sendAudio(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
        });
      } else {
        await bot.api.sendDocument(chatId, file, {
          caption,
          reply_to_message_id: replyToMessageId,
        });
      }
      if (replyToId && !hasReplied) {
        hasReplied = true;
      }
    }
  }
}

function buildSenderName(msg: TelegramMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || msg.from?.username;
  return name || undefined;
}

function buildSenderLabel(msg: TelegramMessage, chatId: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const idPart = `id:${chatId}`;
  return label ? `${label} ${idPart}` : idPart;
}

function buildGroupLabel(msg: TelegramMessage, chatId: number | string) {
  const title = msg.chat?.title;
  if (title) return `${title} id:${chatId}`;
  return `group:${chatId}`;
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
    throw new Error("fetch is not available; set telegram.proxy in config");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download telegram file: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const data = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer: data,
    headerMime: res.headers.get("content-type"),
    filePath: file.file_path,
  });
  const saved = await saveMediaBuffer(data, mime, "inbound", maxBytes);
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
  opts?: { replyToMessageId?: number },
): Promise<number | undefined> {
  try {
    const res = await bot.api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_to_message_id: opts?.replyToMessageId,
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(
        `telegram markdown parse failed; retrying without formatting: ${errText}`,
      );
      const res = await bot.api.sendMessage(chatId, text, {
        reply_to_message_id: opts?.replyToMessageId,
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
