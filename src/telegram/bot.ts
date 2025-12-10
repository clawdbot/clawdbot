// @ts-nocheck
import { Buffer } from "node:buffer";

import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, Message } from "grammy";
import { Bot, InputFile, webhookCallback } from "grammy";

import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { danger, logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";

type TelegramMessage = Message.CommonMessage;

type TelegramContext = {
  message: TelegramMessage;
  me?: { username?: string; token?: string };
  api?: { token?: string };
  getFile: () => Promise<{
    getUrl?: (token?: string) => string | Promise<string>;
    download: () => Promise<Uint8Array | ArrayBuffer>;
    file_path?: string;
  }>;
};

export type TelegramBotOptions = {
  token: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
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

  const cfg = loadConfig();
  const requireMention =
    opts.requireMention ?? cfg.telegram?.requireMention ?? true;
  const allowFrom = opts.allowFrom ?? cfg.telegram?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.telegram?.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) return;
      const chatId = msg.chat.id;
      const isGroup =
        msg.chat.type === "group" || msg.chat.type === "supergroup";

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

      const botUsername = ctx.me?.username?.toLowerCase();
      if (
        isGroup &&
        requireMention &&
        botUsername &&
        !hasBotMention(msg, botUsername)
      ) {
        logger.info({ chatId, reason: "no-mention" }, "skipping group message");
        return;
      }

      const media = await resolveMedia(ctx, mediaMaxBytes);
      const rawBody = (
        msg.text ??
        msg.caption ??
        media?.placeholder ??
        ""
      ).trim();
      if (!rawBody) return;

      const body = formatAgentEnvelope({
        surface: "Telegram",
        from: isGroup
          ? buildGroupLabel(msg, chatId)
          : buildSenderLabel(msg, chatId),
        timestamp: msg.date ? msg.date * 1000 : undefined,
        body: rawBody,
      });

      const ctxPayload = {
        Body: body,
        From: isGroup ? `group:${chatId}` : `telegram:${chatId}`,
        To: `telegram:${chatId}`,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
        SenderName: buildSenderName(msg),
        Surface: "telegram",
        MessageSid: String(msg.message_id),
        Timestamp: msg.date ? msg.date * 1000 : undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
      };

      if (logVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        { onReplyStart: sendTyping },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        chatId: String(chatId),
        token: opts.token,
        runtime,
        bot,
      });
    } catch (err) {
      runtime.error?.(danger(`Telegram handler failed: ${String(err)}`));
    }
  });

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
}) {
  const { replies, chatId, runtime, bot } = params;
  for (const reply of replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      runtime.error?.(danger("Telegram reply missing text/media"));
      continue;
    }
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    if (mediaList.length === 0) {
      for (const chunk of chunkText(reply.text || "", 4000)) {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      }
      continue;
    }
    // media with optional caption on first item
    let first = true;
    for (const mediaUrl of mediaList) {
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const file = new InputFile(media.buffer, media.fileName ?? "file");
      const caption = first ? (reply.text ?? undefined) : undefined;
      first = false;
      if (kind === "image") {
        await bot.api.sendPhoto(chatId, file, { caption });
      } else if (kind === "video") {
        await bot.api.sendVideo(chatId, file, { caption });
      } else if (kind === "audio") {
        await bot.api.sendAudio(chatId, file, { caption });
      } else {
        await bot.api.sendDocument(chatId, file, { caption });
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

async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
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
  const url =
    typeof file.getUrl === "function"
      ? file.getUrl(ctx.me?.token ?? ctx.api?.token ?? undefined)
      : undefined;
  const data =
    url && typeof fetch !== "undefined"
      ? Buffer.from(await (await fetch(url)).arrayBuffer())
      : Buffer.from(await file.download());
  const mime = detectMime({
    buffer: data,
    filePath: file.file_path ?? undefined,
  });
  const saved = await saveMediaBuffer(data, mime, "inbound", maxBytes);
  let placeholder = "<media:document>";
  if (msg.photo) placeholder = "<media:image>";
  else if (msg.video) placeholder = "<media:video>";
  else if (msg.audio || msg.voice) placeholder = "<media:audio>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}
