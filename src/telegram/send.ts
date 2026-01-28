import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReactionType,
  ReactionTypeEmoji,
} from "@grammyjs/types";
import { type ApiClientOptions, Bot, HttpError, InputFile } from "grammy";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import type { RetryConfig } from "../infra/retry.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mediaKindFromMime } from "../media/constants.js";
import { isGifMedia } from "../media/mime.js";
import { loadWebMedia } from "../web/media.js";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
import { renderTelegramHtmlText } from "./format.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { splitTelegramCaption } from "./caption.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget, stripTelegramInternalPrefixes } from "./targets.js";
import { resolveTelegramVoiceSend } from "./voice.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";

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
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Quote text for Telegram reply_parameters. */
  quoteText?: string;
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
const diagLogger = createSubsystemLogger("telegram/diagnostic");

function createTelegramHttpLogger(cfg: ReturnType<typeof loadConfig>) {
  const enabled = isDiagnosticFlagEnabled("telegram.http", cfg);
  if (!enabled) {
    return () => {};
  }
  return (label: string, err: unknown) => {
    if (!(err instanceof HttpError)) return;
    const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
    diagLogger.warn(`telegram http error (${label}): ${detail}`);
  };
}

function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): ApiClientOptions | undefined {
  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const fetchImpl = resolveTelegramFetch(proxyFetch, {
    network: account.config.network,
  });
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;
  return fetchImpl || timeoutSeconds
    ? {
        ...(fetchImpl ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
      }
    : undefined;
}

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
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const mediaUrl = opts.mediaUrl?.trim();
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  // Build optional params for forum topics and reply threading.
  // Only include these if actually provided to keep API calls clean.
  const messageThreadId =
    opts.messageThreadId != null ? opts.messageThreadId : target.messageThreadId;
  const threadIdParams = buildTelegramThreadParams(messageThreadId);
  const threadParams: Record<string, unknown> = threadIdParams ? { ...threadIdParams } : {};
  const quoteText = opts.quoteText?.trim();
  if (opts.replyToMessageId != null) {
    if (quoteText) {
      threadParams.reply_parameters = {
        message_id: Math.trunc(opts.replyToMessageId),
        quote: quoteText,
      };
    } else {
      threadParams.reply_to_message_id = Math.trunc(opts.replyToMessageId);
    }
  }
  const hasThreadParams = Object.keys(threadParams).length > 0;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
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

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  const renderHtmlText = (value: string) => renderTelegramHtmlText(value, { textMode, tableMode });

  // Resolve link preview setting from config (default: enabled).
  const linkPreviewEnabled = account.config.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

  const sendTelegramText = async (
    rawText: string,
    params?: Record<string, unknown>,
    fallbackText?: string,
  ) => {
    const htmlText = renderHtmlText(rawText);
    const baseParams = params ? { ...params } : {};
    if (linkPreviewOptions) {
      baseParams.link_preview_options = linkPreviewOptions;
    }
    const hasBaseParams = Object.keys(baseParams).length > 0;
    const sendParams = {
      parse_mode: "HTML" as const,
      ...baseParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const res = await requestWithDiag(
      () => api.sendMessage(chatId, htmlText, sendParams),
      "message",
    ).catch(async (err) => {
      // Telegram rejects malformed HTML (e.g., unsupported tags or entities).
      // When that happens, fall back to plain text so the message still delivers.
      const errText = formatErrorMessage(err);
      if (PARSE_ERR_RE.test(errText)) {
        if (opts.verbose) {
          console.warn(`telegram HTML parse failed, retrying as plain text: ${errText}`);
        }
        const fallback = fallbackText ?? rawText;
        const plainParams = hasBaseParams ? baseParams : undefined;
        return await requestWithDiag(
          () =>
            plainParams
              ? api.sendMessage(chatId, fallback, plainParams)
              : api.sendMessage(chatId, fallback),
          "message-plain",
        ).catch((err2) => {
          throw wrapChatNotFound(err2);
        });
      }
      throw wrapChatNotFound(err);
    });
    return res;
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
    const { caption, followUpText } = splitTelegramCaption(text);
    const htmlCaption = caption ? renderHtmlText(caption) : undefined;
    // If text exceeds Telegram's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = Boolean(followUpText);
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const baseMediaParams = {
      ...(hasThreadParams ? threadParams : {}),
      ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    const mediaParams = {
      caption: htmlCaption,
      ...(htmlCaption ? { parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    let result:
      | Awaited<ReturnType<typeof api.sendPhoto>>
      | Awaited<ReturnType<typeof api.sendVideo>>
      | Awaited<ReturnType<typeof api.sendAudio>>
      | Awaited<ReturnType<typeof api.sendVoice>>
      | Awaited<ReturnType<typeof api.sendAnimation>>
      | Awaited<ReturnType<typeof api.sendDocument>>;
    if (isGif) {
      result = await requestWithDiag(
        () => api.sendAnimation(chatId, file, mediaParams),
        "animation",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    } else if (kind === "image") {
      result = await requestWithDiag(() => api.sendPhoto(chatId, file, mediaParams), "photo").catch(
        (err) => {
          throw wrapChatNotFound(err);
        },
      );
    } else if (kind === "video") {
      result = await requestWithDiag(() => api.sendVideo(chatId, file, mediaParams), "video").catch(
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
        result = await requestWithDiag(
          () => api.sendVoice(chatId, file, mediaParams),
          "voice",
        ).catch((err) => {
          throw wrapChatNotFound(err);
        });
      } else {
        result = await requestWithDiag(
          () => api.sendAudio(chatId, file, mediaParams),
          "audio",
        ).catch((err) => {
          throw wrapChatNotFound(err);
        });
      }
    } else {
      result = await requestWithDiag(
        () => api.sendDocument(chatId, file, mediaParams),
        "document",
      ).catch((err) => {
        throw wrapChatNotFound(err);
      });
    }
    const mediaMessageId = String(result?.message_id ?? "unknown");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    if (result?.message_id) {
      recordSentMessage(chatId, result.message_id);
    }
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      const textParams =
        hasThreadParams || replyMarkup
          ? {
              ...threadParams,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }
          : undefined;
      const textRes = await sendTelegramText(followUpText, textParams);
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
  const textParams =
    hasThreadParams || replyMarkup
      ? {
          ...threadParams,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  const res = await sendTelegramText(text, textParams, opts.plainText);
  const messageId = String(res?.message_id ?? "unknown");
  if (res?.message_id) {
    recordSentMessage(chatId, res.message_id);
  }
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
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
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
  await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
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
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage");
  logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
}

type TelegramEditOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  /** Optional config injection to avoid global loadConfig() (improves testability). */
  cfg?: ReturnType<typeof loadConfig>;
};

export async function editMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts = {},
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      fn: () => request(fn, label),
    }).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  const htmlText = renderTelegramHtmlText(text, { textMode, tableMode });

  // Reply markup semantics:
  // - buttons === undefined → don't send reply_markup (keep existing)
  // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
  // - otherwise → send built inline keyboard
  const shouldTouchButtons = opts.buttons !== undefined;
  const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
  const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;

  const editParams: Record<string, unknown> = {
    parse_mode: "HTML",
  };
  if (replyMarkup !== undefined) {
    editParams.reply_markup = replyMarkup;
  }

  await requestWithDiag(
    () => api.editMessageText(chatId, messageId, htmlText, editParams),
    "editMessage",
  ).catch(async (err) => {
    // Telegram rejects malformed HTML. Fall back to plain text.
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText)) {
      if (opts.verbose) {
        console.warn(`telegram HTML parse failed, retrying as plain text: ${errText}`);
      }
      const plainParams: Record<string, unknown> = {};
      if (replyMarkup !== undefined) {
        plainParams.reply_markup = replyMarkup;
      }
      return await requestWithDiag(
        () =>
          Object.keys(plainParams).length > 0
            ? api.editMessageText(chatId, messageId, text, plainParams)
            : api.editMessageText(chatId, messageId, text),
        "editMessage-plain",
      );
    }
    throw err;
  });

  logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
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

type TelegramStickerOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts = {},
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;

  const messageThreadId =
    opts.messageThreadId != null ? opts.messageThreadId : target.messageThreadId;
  const threadIdParams = buildTelegramThreadParams(messageThreadId);
  const threadParams: Record<string, number> = threadIdParams ? { ...threadIdParams } : {};
  if (opts.replyToMessageId != null) {
    threadParams.reply_to_message_id = Math.trunc(opts.replyToMessageId);
  }
  const hasThreadParams = Object.keys(threadParams).length > 0;

  const request = createTelegramRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createTelegramHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    request(fn, label).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
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

  const stickerParams = hasThreadParams ? threadParams : undefined;

  const result = await requestWithDiag(
    () => api.sendSticker(chatId, fileId.trim(), stickerParams),
    "sticker",
  ).catch((err) => {
    throw wrapChatNotFound(err);
  });

  const messageId = String(result?.message_id ?? "unknown");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  if (result?.message_id) {
    recordSentMessage(chatId, result.message_id);
  }
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId, chatId: resolvedChatId };
}
