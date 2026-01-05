// @ts-nocheck
import { Buffer } from "node:buffer";

import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions, BotCommand, Message } from "grammy";
import { Bot, InputFile, webhookCallback } from "grammy";
import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { mediaKindFromMime } from "../media/constants.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

type TelegramMessage = Message.CommonMessage;

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

  const cfg = loadConfig();
  const textLimit = resolveTextChunkLimit(cfg, "telegram");
  const allowFrom = opts.allowFrom ?? cfg.telegram?.allowFrom;
  const replyToMode = opts.replyToMode ?? cfg.telegram?.replyToMode ?? "off";
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.telegram?.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const resolveGroupRequireMention = (chatId: string | number) => {
    const groupId = String(chatId);
    const groupConfig = cfg.telegram?.groups?.[groupId];
    if (typeof groupConfig?.requireMention === "boolean") {
      return groupConfig.requireMention;
    }
    const groupDefault = cfg.telegram?.groups?.["*"]?.requireMention;
    if (typeof groupDefault === "boolean") return groupDefault;
    if (typeof opts.requireMention === "boolean") return opts.requireMention;
    return true;
  };

  const registerCommands = async () => {
    const commands: BotCommand[] = [
      { command: "help", description: "Show available commands" },
      { command: "status", description: "Show current status" },
      { command: "new", description: "Start a new conversation" },
      { command: "stop", description: "Stop current generation" },
      { command: "model", description: "Show or change the model" },
      { command: "thinking", description: "Set thinking level" },
    ];
    try {
      await bot.api.setMyCommands(commands, {
        scope: { type: "all_private_chats" },
      });
      logVerbose("Registered Telegram slash commands");
    } catch (err) {
      logVerbose(`Failed to register Telegram commands: ${String(err)}`);
    }
  };
  void registerCommands();

  const workingMessages = new Map<
    string,
    {
      messageId: number;
      text: string;
      lastEdit: number;
      editQueue: Promise<void>;
    }
  >();
  const EDIT_THROTTLE_MS = 250;
  const TELEGRAM_MAX_LENGTH = 4096;

  const editWorkingMessage = async (
    chatId: string,
    text: string,
    opts?: { force?: boolean },
  ) => {
    const state = workingMessages.get(chatId);

    let truncatedText = text;
    if (truncatedText.length > TELEGRAM_MAX_LENGTH - 50) {
      truncatedText =
        truncatedText.slice(0, TELEGRAM_MAX_LENGTH - 50) +
        "\n\n_(truncated)_";
    }

    const displayText = truncatedText || "_..._";

    if (!state) {
      try {
        let result;
        try {
          result = await bot.api.sendMessage(Number(chatId), displayText, {
            parse_mode: "Markdown",
          });
        } catch {
          result = await bot.api.sendMessage(
            Number(chatId),
            displayText.replace(/_/g, ""),
          );
        }
        workingMessages.set(chatId, {
          messageId: result.message_id,
          text: displayText,
          lastEdit: Date.now(),
          editQueue: Promise.resolve(),
        });
      } catch (err) {
        logVerbose(`Failed to send working message: ${String(err)}`);
      }
      return;
    }

    if (state.text === displayText) return;

    const now = Date.now();
    if (!opts?.force && now - state.lastEdit < EDIT_THROTTLE_MS) return;

    state.editQueue = state.editQueue.then(async () => {
      try {
        try {
          await bot.api.editMessageText(
            Number(chatId),
            state.messageId,
            displayText,
            { parse_mode: "Markdown" },
          );
        } catch (err) {
          const errStr = String(err);
          if (PARSE_ERR_RE.test(errStr)) {
            await bot.api.editMessageText(
              Number(chatId),
              state.messageId,
              displayText.replace(/_/g, ""),
            );
          } else if (
            !errStr.includes("message is not modified") &&
            !errStr.includes("MESSAGE_NOT_MODIFIED")
          ) {
            throw err;
          }
        }
        state.text = displayText;
        state.lastEdit = Date.now();
      } catch (err) {
        const errStr = String(err);
        if (
          !errStr.includes("message is not modified") &&
          !errStr.includes("MESSAGE_NOT_MODIFIED")
        ) {
          logVerbose(`Failed to edit working message: ${errStr}`);
        }
      }
    });
    await state.editQueue;
  };

  const clearWorkingMessage = (chatId: string) => {
    workingMessages.delete(chatId);
  };

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
        Boolean(botUsername) && hasBotMention(msg, botUsername);
      const hasAnyMention = (msg.entities ?? msg.caption_entities ?? []).some(
        (ent) => ent.type === "mention",
      );
      const shouldBypassMention =
        isGroup &&
        resolveGroupRequireMention(chatId) &&
        !wasMentioned &&
        !hasAnyMention &&
        commandAuthorized &&
        hasControlCommand(msg.text ?? msg.caption ?? "");
      if (isGroup && resolveGroupRequireMention(chatId) && botUsername) {
        if (!wasMentioned && !shouldBypassMention) {
          logger.info(
            { chatId, reason: "no-mention" },
            "skipping group message",
          );
          return;
        }
      }

      const media = await resolveMedia(
        ctx,
        mediaMaxBytes,
        opts.token,
        opts.proxyFetch,
      );
      const replyTarget = describeReplyTarget(msg);
      const rawBody = (
        msg.text ??
        msg.caption ??
        media?.placeholder ??
        ""
      ).trim();
      if (!rawBody) return;
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
        body: `${rawBody}${replySuffix}`,
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
        WasMentioned: isGroup && botUsername ? wasMentioned : undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
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
        logVerbose(
          `telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
        );
      }

      const statusLines: string[] = [];
      let streamedText = "";
      const chatIdStr = String(chatId);

      const buildDisplayText = (content: string) => {
        if (!content) return statusLines.join("\n");
        if (statusLines.length === 0) return content;
        return `${statusLines.join("\n")}\n\n${content}`;
      };

      const updateWorkingMessage = async (
        content: string,
        opts?: { force?: boolean },
      ) => {
        const displayText = buildDisplayText(content);
        if (!displayText) return;
        await editWorkingMessage(chatIdStr, displayText, opts);
      };

      const onPartialReply = async (payload: ReplyPayload) => {
        if (!payload.text) return;
        streamedText = payload.text;
        await updateWorkingMessage(streamedText);
      };

      const onToolResult = async (payload: ReplyPayload) => {
        if (!payload.text) return;
        statusLines.push(`_${payload.text}_`);
        await updateWorkingMessage(streamedText);
      };

      const dispatcher = createReplyDispatcher({
        responsePrefix: cfg.messages?.responsePrefix,
        deliver: async (payload, info) => {
          if (info.kind !== "final") return;
          const hasMedia =
            Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

          if (!hasMedia && payload.text) {
            streamedText = payload.text;
            await editWorkingMessage(chatIdStr, payload.text, { force: true });
            clearWorkingMessage(chatIdStr);
            return;
          }

          const workingState = workingMessages.get(chatIdStr);
          if (workingState) {
            try {
              await bot.api.deleteMessage(
                Number(chatIdStr),
                workingState.messageId,
              );
            } catch {
              // ignore delete errors
            }
            clearWorkingMessage(chatIdStr);
          }

          await deliverReplies({
            replies: [payload],
            chatId: chatIdStr,
            token: opts.token,
            runtime,
            bot,
            replyToMode,
            textLimit,
          });
        },
        onError: (err, info) => {
          runtime.error?.(
            danger(`telegram ${info.kind} reply failed: ${String(err)}`),
          );
        },
      });

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        {
          onReplyStart: sendTyping,
          onPartialReply,
          onToolResult,
        },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      let queuedFinal = false;
      for (const reply of replies) {
        queuedFinal = dispatcher.sendFinalReply(reply) || queuedFinal;
      }
      await dispatcher.waitForIdle();
      if (!queuedFinal) {
        const workingState = workingMessages.get(chatIdStr);
        if (workingState) {
          try {
            await bot.api.deleteMessage(
              Number(chatIdStr),
              workingState.messageId,
            );
          } catch {
            // ignore delete errors
          }
          clearWorkingMessage(chatIdStr);
        }
        return;
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
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
      const file = new InputFile(media.buffer, media.fileName ?? "file");
      const caption = first ? (reply.text ?? undefined) : undefined;
      first = false;
      const replyToMessageId =
        replyToId && (replyToMode === "all" || !hasReplied)
          ? replyToId
          : undefined;
      if (kind === "image") {
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
