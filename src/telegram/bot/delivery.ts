import { type Bot, InputFile } from "grammy";
import { markdownToTelegramChunks, markdownToTelegramHtml } from "../format.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/config.js";
import { danger, logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { isGifMedia } from "../../media/mime.js";
import { saveMediaBuffer } from "../../media/store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadWebMedia } from "../../web/media.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import { buildTelegramThreadParams, resolveTelegramReplyId } from "./helpers.js";
import type { TelegramContext } from "./types.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  replyToMode: ReplyToMode;
  textLimit: number;
  messageThreadId?: number;
}) {
  const { replies, chatId, runtime, bot, replyToMode, textLimit, messageThreadId } = params;
  const threadParams = buildTelegramThreadParams(messageThreadId);
  let hasReplied = false;
  for (const reply of replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      runtime.error?.(danger("reply missing text/media"));
      continue;
    }
    const replyToId = replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];
    if (mediaList.length === 0) {
      const chunks = markdownToTelegramChunks(reply.text || "", textLimit);
      for (const chunk of chunks) {
        await sendTelegramText(bot, chatId, chunk.html, runtime, {
          replyToMessageId:
            replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined,
          messageThreadId,
          textMode: "html",
          plainText: chunk.text,
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
        replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
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

export async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  proxyFetch?: typeof fetch,
): Promise<{ path: string; contentType?: string; placeholder: string } | null> {
  const msg = ctx.message;
  const m =
    msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.document ?? msg.audio ?? msg.voice;
  if (!m?.file_id) return null;
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const fetched = await fetchRemoteMedia({
    url,
    fetchImpl,
    filePathHint: file.file_path,
  });
  const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes);
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
  opts?: {
    replyToMessageId?: number;
    messageThreadId?: number;
    textMode?: "markdown" | "html";
    plainText?: string;
  },
): Promise<number | undefined> {
  const threadParams = buildTelegramThreadParams(opts?.messageThreadId);
  const baseParams: Record<string, unknown> = {
    reply_to_message_id: opts?.replyToMessageId,
  };
  if (threadParams) {
    baseParams.message_thread_id = threadParams.message_thread_id;
  }
  const textMode = opts?.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  try {
    const res = await bot.api.sendMessage(chatId, htmlText, {
      parse_mode: "HTML",
      ...baseParams,
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(`telegram HTML parse failed; retrying without formatting: ${errText}`);
      const fallbackText = opts?.plainText ?? text;
      const res = await bot.api.sendMessage(chatId, fallbackText, {
        ...baseParams,
      });
      return res.message_id;
    }
    throw err;
  }
}
