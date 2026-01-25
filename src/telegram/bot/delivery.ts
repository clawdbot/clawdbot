import { type Bot, InputFile } from "grammy";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
} from "../format.js";
import { chunkMarkdownTextWithMode, type ChunkMode } from "../../auto-reply/chunk.js";
import { splitTelegramCaption } from "../caption.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/config.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
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
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
}) {
  const { replies, chatId, runtime, bot, replyToMode, textLimit, messageThreadId } = params;
  const chunkMode = params.chunkMode ?? "length";
  const threadParams = buildTelegramThreadParams(messageThreadId);
  let hasReplied = false;
  const chunkText = (markdown: string) => {
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(markdown, textLimit, chunkMode)
        : [markdown];
    const chunks: ReturnType<typeof markdownToTelegramChunks> = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, textLimit, { tableMode: params.tableMode });
      if (!nested.length && chunk) {
        chunks.push({
          html: markdownToTelegramHtml(chunk, { tableMode: params.tableMode }),
          text: chunk,
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  };
  for (const reply of replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
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
      const chunks = chunkText(reply.text || "");
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
    // Track if we need to send a follow-up text message after media
    // (when caption exceeds Telegram's 1024-char limit)
    let pendingFollowUpText: string | undefined;
    for (const mediaUrl of mediaList) {
      const isFirstMedia = first;
      const media = await loadWebMedia(mediaUrl);
      const kind = mediaKindFromMime(media.contentType ?? undefined);
      const isGif = isGifMedia({
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
      const file = new InputFile(media.buffer, fileName);
      // Caption only on first item; if text exceeds limit, defer to follow-up message.
      const { caption, followUpText } = splitTelegramCaption(
        isFirstMedia ? (reply.text ?? undefined) : undefined,
      );
      const htmlCaption = caption
        ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
        : undefined;
      if (followUpText) {
        pendingFollowUpText = followUpText;
      }
      first = false;
      const replyToMessageId =
        replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
      const mediaParams: Record<string, unknown> = {
        caption: htmlCaption,
        reply_to_message_id: replyToMessageId,
        ...(htmlCaption ? { parse_mode: "HTML" } : {}),
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
          // Switch typing indicator to record_voice before sending.
          await params.onVoiceRecording?.();
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
      // Send deferred follow-up text right after the first media item.
      // Chunk it in case it's extremely long (same logic as text-only replies).
      if (pendingFollowUpText && isFirstMedia) {
        const chunks = chunkText(pendingFollowUpText);
        for (const chunk of chunks) {
          const replyToMessageIdFollowup =
            replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
          await sendTelegramText(bot, chatId, chunk.html, runtime, {
            replyToMessageId: replyToMessageIdFollowup,
            messageThreadId,
            textMode: "html",
            plainText: chunk.text,
          });
          if (replyToId && !hasReplied) {
            hasReplied = true;
          }
        }
        pendingFollowUpText = undefined;
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

function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  messageThreadId?: number;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.messageThreadId);
  const params: Record<string, unknown> = {};
  if (opts?.replyToMessageId) {
    params.reply_to_message_id = opts.replyToMessageId;
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  return params;
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
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    messageThreadId: opts?.messageThreadId,
  });
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
