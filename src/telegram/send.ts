import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReactionType,
  ReactionTypeEmoji,
} from "@grammyjs/types";
import { type ApiClientOptions, Bot, InputFile } from "grammy";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RetryConfig } from "../infra/retry.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import { mediaKindFromMime } from "../media/constants.js";
import { isGifMedia } from "../media/mime.js";
import { loadWebMedia } from "../web/media.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramFetch } from "./fetch.js";
import { markdownToTelegramHtml } from "./format.js";
import { parseTelegramTarget, stripTelegramInternalPrefixes } from "./targets.js";
import { resolveTelegramVoiceSend } from "./voice.js";

type TelegramSendOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  maxBytes?: number;
  api?: Bot["api"];
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  plainText?: string;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
};

type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

type TelegramReactionOpts = {
  token?: string;
  accountId?: string;
  api?: Bot["api"];
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
};

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

// Telegram limits media captions to 1024 characters.
// Text beyond this must be sent as a separate follow-up message.
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

function resolveToken(explicit: string | undefined, params: { accountId: string; token: string }) {
  if (explicit?.trim()) return explicit.trim();
  if (!params.token) {
    throw new Error(
      `Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }
  return params.token.trim();
}

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for Telegram sends");

  // Common internal prefixes that sometimes leak into outbound sends.
  // - ctx.To uses `telegram:<id>`
  // - group sessions often use `telegram:group:<id>`
  let normalized = stripTelegramInternalPrefixes(trimmed);

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

function normalizeMessageId(raw: string | number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new Error("Message id is required for Telegram actions");
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("Message id is required for Telegram actions");
}

export function buildInlineKeyboard(
  buttons?: TelegramSendOpts["buttons"],
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) return undefined;
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map(
          (button): InlineKeyboardButton => ({
            text: button.text,
            callback_data: button.callback_data,
          }),
        ),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) return undefined;
  return { inline_keyboard: rows };
}

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts = {},
): Promise<TelegramSendResult> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);
  // Use provided api or create a new Bot instance. The nullish coalescing
  // operator ensures api is always defined (Bot.api is always non-null).
  const fetchImpl = resolveTelegramFetch();
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;
  const client: ApiClientOptions | undefined =
    fetchImpl || timeoutSeconds
      ? {
          ...(fetchImpl ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
      : undefined;
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const mediaUrl = opts.mediaUrl?.trim();
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  // Build optional params for forum topics and reply threading.
  // Only include these if actually provided to keep API calls clean.
  const threadParams: Record<string, number> = {};
  const messageThreadId =
    opts.messageThreadId != null ? opts.messageThreadId : target.messageThreadId;
  if (messageThreadId != null) {
    threadParams.message_thread_id = Math.trunc(messageThreadId);
  }
  if (opts.replyToMessageId != null) {
    threadParams.reply_to_message_id = Math.trunc(opts.replyToMessageId);
  }
  const hasThreadParams = Object.keys(threadParams).length > 0;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });

  const wrapChatNotFound = (err: unknown) => {
    if (!/400: Bad Request: chat not found/i.test(formatErrorMessage(err))) return err;
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
    const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind)) ?? "file";
    const file = new InputFile(media.buffer, fileName);
    const trimmedText = text?.trim() || "";
    // If text exceeds Telegram's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = trimmedText.length > TELEGRAM_MAX_CAPTION_LENGTH;
    const caption = needsSeparateText ? undefined : trimmedText || undefined;
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const mediaParams = hasThreadParams
      ? {
          caption,
          ...threadParams,
          ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : {
          caption,
          ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
        };
    let result:
      | Awaited<ReturnType<typeof api.sendPhoto>>
      | Awaited<ReturnType<typeof api.sendVideo>>
      | Awaited<ReturnType<typeof api.sendAudio>>
      | Awaited<ReturnType<typeof api.sendVoice>>
      | Awaited<ReturnType<typeof api.sendAnimation>>
      | Awaited<ReturnType<typeof api.sendDocument>>;
    if (isGif) {
      result = await request(() => api.sendAnimation(chatId, file, mediaParams), "animation").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    } else if (kind === "image") {
      result = await request(() => api.sendPhoto(chatId, file, mediaParams), "photo").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    } else if (kind === "video") {
      result = await request(() => api.sendVideo(chatId, file, mediaParams), "video").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    } else if (kind === "audio") {
      const { useVoice } = resolveTelegramVoiceSend({
        wantsVoice: opts.asVoice === true, // default false (backward compatible)
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose,
      });
      if (useVoice) {
        result = await request(() => api.sendVoice(chatId, file, mediaParams), "voice").catch(
          (err) => {
            throw wrapChatNotFound(err);
          },
        );
      } else {
        result = await request(() => api.sendAudio(chatId, file, mediaParams), "audio").catch(
          (err) => {
            throw wrapChatNotFound(err);
          },
        );
      }
    } else {
      result = await request(() => api.sendDocument(chatId, file, mediaParams), "document").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    }
    const mediaMessageId = String(result?.message_id ?? "unknown");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use plain text to match caption behavior (captions don't use HTML conversion).
    if (needsSeparateText && trimmedText) {
      const textParams =
        hasThreadParams || replyMarkup
          ? {
              ...threadParams,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }
          : undefined;
      const textRes = await request(
        () =>
          textParams
            ? api.sendMessage(chatId, trimmedText, textParams)
            : api.sendMessage(chatId, trimmedText),
        "message",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
      // Return the text message ID as the "main" message (it's the actual content).
      return {
        messageId: String(textRes?.message_id ?? mediaMessageId),
        chatId: resolvedChatId,
      };
    }

    return { messageId: mediaMessageId, chatId: resolvedChatId };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Telegram sends");
  }
  const textMode = opts.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const textParams = hasThreadParams
    ? {
        parse_mode: "HTML" as const,
        ...threadParams,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }
    : {
        parse_mode: "HTML" as const,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      };
  const res = await request(() => api.sendMessage(chatId, htmlText, textParams), "message").catch(
    async (err) => {
      // Telegram rejects malformed HTML (e.g., unsupported tags or entities).
      // When that happens, fall back to plain text so the message still delivers.
      const errText = formatErrorMessage(err);
      if (PARSE_ERR_RE.test(errText)) {
        if (opts.verbose) {
          console.warn(`telegram HTML parse failed, retrying as plain text: ${errText}`);
        }
        const plainParams =
          hasThreadParams || replyMarkup
            ? {
                ...threadParams,
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
              }
            : undefined;
        const fallbackText = opts.plainText ?? text;
        return await request(
          () =>
            plainParams
              ? api.sendMessage(chatId, fallbackText, plainParams)
              : api.sendMessage(chatId, fallbackText),
          "message-plain",
        ).catch((err2) => {
          throw wrapChatNotFound(err2);
        });
      }
      throw wrapChatNotFound(err);
    },
  );
  const messageId = String(res?.message_id ?? "unknown");
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return { messageId, chatId: String(res?.chat?.id ?? chatId) };
}

export async function reactMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: TelegramReactionOpts = {},
): Promise<{ ok: true }> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const fetchImpl = resolveTelegramFetch();
  const client: ApiClientOptions | undefined = fetchImpl
    ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
    : undefined;
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const remove = opts.remove === true;
  const trimmedEmoji = emoji.trim();
  // Build the reaction array. We cast emoji to the grammY union type since
  // Telegram validates emoji server-side; invalid emojis fail gracefully.
  const reactions: ReactionType[] =
    remove || !trimmedEmoji
      ? []
      : [{ type: "emoji", emoji: trimmedEmoji as ReactionTypeEmoji["emoji"] }];
  if (typeof api.setMessageReaction !== "function") {
    throw new Error("Telegram reactions are unavailable in this bot API.");
  }
  await request(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
  return { ok: true };
}

type TelegramDeleteOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
};

export async function deleteMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: TelegramDeleteOpts = {},
): Promise<{ ok: true }> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const fetchImpl = resolveTelegramFetch();
  const client: ApiClientOptions | undefined = fetchImpl
    ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
    : undefined;
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  await request(() => api.deleteMessage(chatId, messageId), "deleteMessage");
  logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
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
