import type { Message } from "grammy/types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramMessageThreadSpec } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { isRecoverableTelegramNetworkError, isTelegramServerError } from "./network-errors.js";
import {
  recordOutboundMessageForPromptContext,
  type TelegramOutboundPromptContextMessage,
} from "./outbound-message-context.js";
import { getTelegramRichRawApi } from "./rich-message.js";
import { withTelegramPlainFallback } from "./rich-plain-fallback.js";
import {
  isTelegramMessageHasNoTextError,
  isTelegramMessageNotModifiedError,
  resolveTelegramApiContext,
  sendLogger,
  withTelegramApiContextLease,
  type TelegramApiContext,
} from "./send-context.js";
import type { TelegramApiCallOpts, TelegramSendOpts } from "./send-message-types.js";
import { prepareTelegramOutbound } from "./send-outbound.js";
import { resolveMarkdownTableMode } from "./send.runtime.js";
import {
  deliverTelegramTextPage,
  planTelegramTextDeliveryPages,
} from "./telegram-text-delivery.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

type TelegramEditMessageTextParams = Parameters<TelegramApiContext["api"]["editMessageText"]>[3];
type TelegramEditMessageCaptionParams = Parameters<
  TelegramApiContext["api"]["editMessageCaption"]
>[2];

type TelegramEditReplyMarkupOpts = TelegramApiCallOpts & Pick<TelegramSendOpts, "buttons">;

type TelegramEditOpts = TelegramEditReplyMarkupOpts &
  Pick<TelegramSendOpts, "textMode"> & {
    /** Controls whether link previews are shown in the edited message. */
    linkPreview?: boolean;
    /** Use Telegram's media-caption edit endpoint, or fall back to it when text edits target media. */
    editMode?: "text" | "caption" | "auto";
  };

export async function editMessageReplyMarkupTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  buttons: TelegramInlineButtons,
  opts: TelegramEditReplyMarkupOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    editMessageReplyMarkupTelegramWithContext(chatIdInput, messageIdInput, buttons, opts, context),
  );
}

async function editMessageReplyMarkupTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  buttons: TelegramInlineButtons,
  opts: TelegramEditReplyMarkupOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { api } = context;
  const { chatId, messageId, request } = await prepareTelegramOutbound({
    to: chatIdInput,
    context,
    opts,
    messageIdInput,
    request: { kind: "standard" },
  });
  const replyMarkup = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
  try {
    await request(
      () => api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup }),
      "editMessageReplyMarkup",
      {
        shouldLog: (err) => !isTelegramMessageNotModifiedError(err),
      },
    );
  } catch (err) {
    if (!isTelegramMessageNotModifiedError(err)) {
      throw err;
    }
  }
  logVerbose(`[telegram] Edited reply markup for message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}

export async function editMessageTelegram(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    editMessageTelegramWithContext(chatIdInput, messageIdInput, text, opts, context),
  );
}

async function editMessageTelegramWithContext(
  chatIdInput: string | number,
  messageIdInput: string | number,
  text: string,
  opts: TelegramEditOpts,
  context: TelegramApiContext,
): Promise<{ ok: true; messageId: string; chatId: string }> {
  const { cfg, account, api } = context;
  const { chatId, messageId, request } = await prepareTelegramOutbound({
    to: chatIdInput,
    context,
    opts,
    messageIdInput,
    request: {
      kind: "standard",
      shouldRetry: (err) =>
        isRecoverableTelegramNetworkError(err, { context: "edit" }) || isTelegramServerError(err),
    },
  });
  const requestWithEditShouldLog = <T>(
    fn: () => Promise<T>,
    label?: string,
    shouldLog?: (err: unknown) => boolean,
  ) => request(fn, label, shouldLog ? { shouldLog } : undefined);

  const textMode = opts.textMode ?? "markdown";
  const linkPreviewEnabled = opts.linkPreview ?? account.config.linkPreview ?? true;
  // Caller-authored HTML edits keep legacy parse_mode HTML semantics too.
  const useRichMessages = account.config.richMessages === true && textMode !== "html";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    supportsBlockTables: useRichMessages,
  });
  const htmlText = renderTelegramHtmlText(text, { textMode, tableMode });
  const plainText = textMode === "html" ? telegramHtmlToPlainTextFallback(htmlText) : text;

  // Reply markup semantics:
  // - buttons === undefined → don't send reply_markup (keep existing)
  // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
  // - otherwise → send built inline keyboard
  const shouldTouchButtons = opts.buttons !== undefined;
  const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
  const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;

  const commonTextParams: TelegramEditMessageTextParams = {
    ...(linkPreviewEnabled ? {} : { link_preview_options: { is_disabled: true } }),
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
  };
  const captionEditParams: TelegramEditMessageCaptionParams = {
    caption: htmlText,
    parse_mode: "HTML",
  };
  if (replyMarkup !== undefined) {
    captionEditParams.reply_markup = replyMarkup;
  }
  const plainCaptionParams: TelegramEditMessageCaptionParams = {
    caption: plainText,
  };
  if (replyMarkup !== undefined) {
    plainCaptionParams.reply_markup = replyMarkup;
  }

  const performTextEdit = async () => {
    const page = planTelegramTextDeliveryPages({
      text: textMode === "html" ? htmlText : text,
      maxChars: Number.MAX_SAFE_INTEGER,
      tableMode,
      richMessages: useRichMessages,
      skipEntityDetection: !linkPreviewEnabled,
      ...(textMode === "html" ? { textMode: "html" as const } : {}),
    })[0];
    if (!page) {
      throw new Error("telegram editMessage failed: empty text");
    }
    const edit = <T>(fn: () => Promise<T>, label = "editMessage") =>
      requestWithEditShouldLog(fn, label, (err) => !isTelegramMessageNotModifiedError(err));
    const [accepted] = await deliverTelegramTextPage({
      page,
      context: "editMessage",
      warn: (message) => sendLogger.warn(message),
      fallbackLimit: Number.MAX_SAFE_INTEGER,
      sender: {
        sendPlain: (value, _fallback, label) =>
          edit(
            () =>
              Object.keys(commonTextParams).length
                ? api.editMessageText(chatId, messageId, value, commonTextParams)
                : api.editMessageText(chatId, messageId, value),
            label,
          ),
        sendHtml: (value) =>
          edit(() =>
            api.editMessageText(chatId, messageId, value, {
              parse_mode: "HTML",
              ...commonTextParams,
            }),
          ),
        sendRich: (richMessage) =>
          edit(() =>
            getTelegramRichRawApi(api).editMessageText({
              chat_id: chatId,
              message_id: messageId,
              rich_message: richMessage,
              ...commonTextParams,
            }),
          ),
      },
    });
    return accepted!.result;
  };

  const performCaptionEdit = () =>
    withTelegramPlainFallback({
      kind: "html",
      context: "editMessageCaption",
      plainText,
      warn: (message) => sendLogger.warn(message),
      sendFormatted: () =>
        requestWithEditShouldLog(
          () => api.editMessageCaption(chatId, messageId, captionEditParams),
          "editMessageCaption",
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      sendPlain: (_plan, label) =>
        requestWithEditShouldLog(
          () => api.editMessageCaption(chatId, messageId, plainCaptionParams),
          label,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });

  let editedMessage: TelegramOutboundPromptContextMessage | true | undefined;
  try {
    const editMode = opts.editMode ?? "text";
    if (editMode === "caption") {
      editedMessage = await performCaptionEdit();
    } else {
      try {
        editedMessage = await performTextEdit();
      } catch (err) {
        if (editMode === "auto" && isTelegramMessageHasNoTextError(err)) {
          editedMessage = await performCaptionEdit();
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    if (isTelegramMessageNotModifiedError(err)) {
      // no-op: Telegram reports message content unchanged, treat as success
    } else {
      throw err;
    }
  }

  if (editedMessage && editedMessage !== true && typeof editedMessage.message_id === "number") {
    const botUserId = resolveTelegramBotUserIdFromToken(opts.token || account.token);
    const successfulSendThread = resolveTelegramMessageThreadSpec(editedMessage as Message);
    await recordOutboundMessageForPromptContext({
      cfg,
      account,
      chatId,
      message: editedMessage,
      messageId: editedMessage.message_id,
      recordGroupHistory: false,
      successfulSendThread,
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(editedMessage.message_thread_id !== undefined
        ? { messageThreadId: editedMessage.message_thread_id }
        : {}),
    });
  }

  logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}
