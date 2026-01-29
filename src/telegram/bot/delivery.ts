import { type Bot, GrammyError, InputFile } from "grammy";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
} from "../format.js";
import { withTelegramApiErrorLogging } from "../api-logging.js";
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
import { buildInlineKeyboard } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import { buildTelegramThreadParams, resolveTelegramReplyId } from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;

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
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
}) {
  const {
    replies,
    chatId,
    runtime,
    bot,
    replyToMode,
    textLimit,
    messageThreadId,
    linkPreview,
    replyQuoteText,
  } = params;
  const chunkMode = params.chunkMode ?? "length";
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
    const telegramData = reply.channelData?.telegram as
      | { buttons?: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
    if (mediaList.length === 0) {
      const chunks = chunkText(reply.text || "");
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) continue;
        // Only attach buttons to the first chunk.
        const shouldAttachButtons = i === 0 && replyMarkup;
        await sendTelegramText(bot, chatId, chunk.html, runtime, {
          replyToMessageId:
            replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined,
          replyQuoteText,
          messageThreadId,
          textMode: "html",
          plainText: chunk.text,
          linkPreview,
          replyMarkup: shouldAttachButtons ? replyMarkup : undefined,
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
      const shouldAttachButtonsToMedia = isFirstMedia && replyMarkup && !followUpText;
      const mediaParams: Record<string, unknown> = {
        caption: htmlCaption,
        ...(htmlCaption ? { parse_mode: "HTML" } : {}),
        ...(shouldAttachButtonsToMedia ? { reply_markup: replyMarkup } : {}),
        ...buildTelegramSendParams({
          replyToMessageId,
          messageThreadId,
          replyQuoteText,
        }),
      };
      if (isGif) {
        await withTelegramApiErrorLogging({
          operation: "sendAnimation",
          runtime,
          fn: () => bot.api.sendAnimation(chatId, file, { ...mediaParams }),
        });
      } else if (kind === "image") {
        await withTelegramApiErrorLogging({
          operation: "sendPhoto",
          runtime,
          fn: () => bot.api.sendPhoto(chatId, file, { ...mediaParams }),
        });
      } else if (kind === "video") {
        await withTelegramApiErrorLogging({
          operation: "sendVideo",
          runtime,
          fn: () => bot.api.sendVideo(chatId, file, { ...mediaParams }),
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
          try {
            await withTelegramApiErrorLogging({
              operation: "sendVoice",
              runtime,
              shouldLog: (err) => !isVoiceMessagesForbidden(err),
              fn: () => bot.api.sendVoice(chatId, file, { ...mediaParams }),
            });
          } catch (voiceErr) {
            // Fall back to text if voice messages are forbidden in this chat.
            // This happens when the recipient has Telegram Premium privacy settings
            // that block voice messages (Settings > Privacy > Voice Messages).
            if (isVoiceMessagesForbidden(voiceErr)) {
              const fallbackText = reply.text;
              if (!fallbackText || !fallbackText.trim()) {
                throw voiceErr;
              }
              logVerbose(
                "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
              );
              hasReplied = await sendTelegramVoiceFallbackText({
                bot,
                chatId,
                runtime,
                text: fallbackText,
                chunkText,
                replyToId,
                replyToMode,
                hasReplied,
                messageThreadId,
                linkPreview,
                replyMarkup,
                replyQuoteText,
              });
              // Skip this media item; continue with next.
              continue;
            }
            throw voiceErr;
          }
        } else {
          // Audio file - displays with metadata (title, duration) - DEFAULT
          await withTelegramApiErrorLogging({
            operation: "sendAudio",
            runtime,
            fn: () => bot.api.sendAudio(chatId, file, { ...mediaParams }),
          });
        }
      } else {
        await withTelegramApiErrorLogging({
          operation: "sendDocument",
          runtime,
          fn: () => bot.api.sendDocument(chatId, file, { ...mediaParams }),
        });
      }
      if (replyToId && !hasReplied) {
        hasReplied = true;
      }
      // Send deferred follow-up text right after the first media item.
      // Chunk it in case it's extremely long (same logic as text-only replies).
      if (pendingFollowUpText && isFirstMedia) {
        const chunks = chunkText(pendingFollowUpText);
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const replyToMessageIdFollowup =
            replyToId && (replyToMode === "all" || !hasReplied) ? replyToId : undefined;
          await sendTelegramText(bot, chatId, chunk.html, runtime, {
            replyToMessageId: replyToMessageIdFollowup,
            messageThreadId,
            textMode: "html",
            plainText: chunk.text,
            linkPreview,
            replyMarkup: i === 0 ? replyMarkup : undefined,
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
): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
  stickerMetadata?: StickerMetadata;
} | null> {
  const msg = ctx.message;

  // Handle stickers separately - only static stickers (WEBP) are supported
  if (msg.sticker) {
    const sticker = msg.sticker;
    // Skip animated (TGS) and video (WEBM) stickers - only static WEBP supported
    if (sticker.is_animated || sticker.is_video) {
      logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
      return null;
    }
    if (!sticker.file_id) return null;

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        logVerbose("telegram: getFile returned no file_path for sticker");
        return null;
      }
      const fetchImpl = proxyFetch ?? globalThis.fetch;
      if (!fetchImpl) {
        logVerbose("telegram: fetch not available for sticker download");
        return null;
      }
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        filePathHint: file.file_path,
      });
      const originalName = fetched.fileName ?? file.file_path;
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
        originalName,
      );

      // Check sticker cache for existing description
      const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
      if (cached) {
        logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
        const fileId = sticker.file_id ?? cached.fileId;
        const emoji = sticker.emoji ?? cached.emoji;
        const setName = sticker.set_name ?? cached.setName;
        if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
          // Refresh cached sticker metadata on hits so sends/searches use latest file_id.
          cacheSticker({
            ...cached,
            fileId,
            emoji,
            setName,
          });
        }
        return {
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:sticker>",
          stickerMetadata: {
            emoji,
            setName,
            fileId,
            fileUniqueId: sticker.file_unique_id,
            cachedDescription: cached.description,
          },
        };
      }

      // Cache miss - return metadata for vision processing
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:sticker>",
        stickerMetadata: {
          emoji: sticker.emoji ?? undefined,
          setName: sticker.set_name ?? undefined,
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
        },
      };
    } catch (err) {
      logVerbose(`telegram: failed to process sticker: ${String(err)}`);
      return null;
    }
  }

  const m =
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.video_note ??
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
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const fetched = await fetchRemoteMedia({
    url,
    fetchImpl,
    filePathHint: file.file_path,
  });
  const originalName = fetched.fileName ?? file.file_path;
  const saved = await saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    maxBytes,
    originalName,
  );
  let placeholder = "<media:document>";
  if (msg.photo) placeholder = "<media:image>";
  else if (msg.video) placeholder = "<media:video>";
  else if (msg.video_note) placeholder = "<media:video>";
  else if (msg.audio || msg.voice) placeholder = "<media:audio>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}

function isVoiceMessagesForbidden(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return VOICE_FORBIDDEN_RE.test(err.description);
  }
  return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}

async function sendTelegramVoiceFallbackText(opts: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  text: string;
  chunkText: (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  hasReplied: boolean;
  messageThreadId?: number;
  linkPreview?: boolean;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
}): Promise<boolean> {
  const chunks = opts.chunkText(opts.text);
  let hasReplied = opts.hasReplied;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      replyToMessageId:
        opts.replyToId && (opts.replyToMode === "all" || !hasReplied) ? opts.replyToId : undefined,
      replyQuoteText: opts.replyQuoteText,
      messageThreadId: opts.messageThreadId,
      textMode: "html",
      plainText: chunk.text,
      linkPreview: opts.linkPreview,
      replyMarkup: i === 0 ? opts.replyMarkup : undefined,
    });
    if (opts.replyToId && !hasReplied) {
      hasReplied = true;
    }
  }
  return hasReplied;
}

function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  messageThreadId?: number;
  replyQuoteText?: string;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.messageThreadId);
  const params: Record<string, unknown> = {};
  const quoteText = opts?.replyQuoteText?.trim();
  if (opts?.replyToMessageId) {
    if (quoteText) {
      params.reply_parameters = {
        message_id: Math.trunc(opts.replyToMessageId),
        quote: quoteText,
      };
    } else {
      params.reply_to_message_id = opts.replyToMessageId;
    }
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
    replyQuoteText?: string;
    messageThreadId?: number;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number | undefined> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    replyQuoteText: opts?.replyQuoteText,
    messageThreadId: opts?.messageThreadId,
  });
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const textMode = opts?.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  try {
    const res = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      shouldLog: (err) => !PARSE_ERR_RE.test(formatErrorMessage(err)),
      fn: () =>
        bot.api.sendMessage(chatId, htmlText, {
          parse_mode: "HTML",
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...baseParams,
        }),
    });
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      runtime.log?.(`telegram HTML parse failed; retrying without formatting: ${errText}`);
      const fallbackText = opts?.plainText ?? text;
      const res = await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime,
        fn: () =>
          bot.api.sendMessage(chatId, fallbackText, {
            ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
            ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...baseParams,
          }),
      });
      return res.message_id;
    }
    throw err;
  }
}
