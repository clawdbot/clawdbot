// @ts-nocheck
import { Bot, InputFile } from "grammy";
import { formatErrorMessage } from "../infra/errors.js";
import { mediaKindFromMime } from "../media/constants.js";
import { isGifMedia } from "../media/mime.js";
import { loadWebMedia } from "../web/media.js";

type TelegramSendOpts = {
  token?: string;
  verbose?: boolean;
  mediaUrl?: string;
  maxBytes?: number;
  api?: Bot["api"];
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

function resolveToken(explicit?: string): string {
  const token = explicit ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required for Telegram sends (Bot API)",
    );
  }
  return token.trim();
}

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for Telegram sends");

  // Common internal prefixes that sometimes leak into outbound sends.
  // - ctx.To uses `telegram:<id>`
  // - group sessions often use `telegram:group:<id>`
  let normalized = trimmed.replace(/^(telegram|tg|group):/i, "").trim();

  // Accept t.me links for public chats/channels.
  // (Invite links like `t.me/+...` are not resolvable via Bot API.)
  const m =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (m?.[1]) normalized = `@${m[1]}`;

  if (!normalized) throw new Error("Recipient is required for Telegram sends");
  if (normalized.startsWith("@")) return normalized;
  if (/^-?\d+$/.test(normalized)) return normalized;

  // If the user passed a username without `@`, assume they meant a public chat/channel.
  if (/^[A-Za-z0-9_]{5,}$/i.test(normalized)) return `@${normalized}`;

  return normalized;
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts = {},
): Promise<TelegramSendResult> {
  const token = resolveToken(opts.token);
  const chatId = normalizeChatId(to);
  const bot = opts.api ? null : new Bot(token);
  const api = opts.api ?? bot?.api;
  const mediaUrl = opts.mediaUrl?.trim();

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const sendWithRetry = async <T>(fn: () => Promise<T>, label: string) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatErrorMessage(err);
        const terminal =
          attempt === 3 ||
          !/429|timeout|connect|reset|closed|unavailable|temporarily/i.test(
            errText,
          );
        if (terminal) break;
        const backoff = 400 * attempt;
        if (opts.verbose) {
          console.warn(
            `telegram send retry ${attempt}/2 for ${label} in ${backoff}ms: ${errText}`,
          );
        }
        await sleep(backoff);
      }
    }
    throw lastErr ?? new Error(`Telegram send failed (${label})`);
  };

  const wrapChatNotFound = (err: unknown) => {
    if (!/400: Bad Request: chat not found/i.test(formatErrorMessage(err)))
      return err;
    return new Error(
      [
        `Telegram send failed: chat not found (chat_id=${chatId}).`,
        "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
        `Input was: ${JSON.stringify(to)}.`,
      ].join(" "),
    );
  };

  if (mediaUrl) {
    const media = await loadWebMedia(mediaUrl, opts.maxBytes);
    const kind = mediaKindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const fileName =
      media.fileName ??
      (isGif ? "animation.gif" : inferFilename(kind)) ??
      "file";
    const file = new InputFile(media.buffer, fileName);
    const caption = text?.trim() || undefined;
    let result:
      | Awaited<ReturnType<typeof api.sendPhoto>>
      | Awaited<ReturnType<typeof api.sendVideo>>
      | Awaited<ReturnType<typeof api.sendAudio>>
      | Awaited<ReturnType<typeof api.sendAnimation>>
      | Awaited<ReturnType<typeof api.sendDocument>>;
    if (isGif) {
      result = await sendWithRetry(
        () => api.sendAnimation(chatId, file, { caption }),
        "animation",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    } else if (kind === "image") {
      result = await sendWithRetry(
        () => api.sendPhoto(chatId, file, { caption }),
        "photo",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    } else if (kind === "video") {
      result = await sendWithRetry(
        () => api.sendVideo(chatId, file, { caption }),
        "video",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    } else if (kind === "audio") {
      result = await sendWithRetry(
        () => api.sendAudio(chatId, file, { caption }),
        "audio",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    } else {
      result = await sendWithRetry(
        () => api.sendDocument(chatId, file, { caption }),
        "document",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    }
    const messageId = String(result?.message_id ?? "unknown");
    return { messageId, chatId: String(result?.chat?.id ?? chatId) };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const res = await sendWithRetry(
    () => api.sendMessage(chatId, text, { parse_mode: "Markdown" }),
    "message",
  ).catch(async (err) => {
    // Telegram rejects malformed Markdown (e.g., unbalanced '_' or '*').
    // When that happens, fall back to plain text so the message still delivers.
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      if (opts.verbose) {
        console.warn(
          `telegram markdown parse failed, retrying as plain text: ${errText}`,
        );
      }
      return await sendWithRetry(
        () => api.sendMessage(chatId, text),
        "message-plain",
      ).catch((err2) => {
        throw wrapChatNotFound(err2);
      });
    }
    throw wrapChatNotFound(err);
  });
  const messageId = String(res?.message_id ?? "unknown");
  return { messageId, chatId: String(res?.chat?.id ?? chatId) };
}

function inferFilename(kind: ReturnType<typeof mediaKindFromMime>) {
  switch (kind) {
    case "image":
      return "image.jpg";
    case "video":
      return "video.mp4";
    case "audio":
      return "audio.ogg";
    default:
      return "file.bin";
  }
}
// @ts-nocheck
