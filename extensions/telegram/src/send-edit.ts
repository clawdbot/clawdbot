import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramInlineButtons } from "./button-types.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { isRecoverableTelegramNetworkError, isTelegramServerError } from "./network-errors.js";
import {
  buildTelegramRichMarkdownPlan,
  getTelegramRichRawApi,
  type TelegramEditRichMessageTextParams,
} from "./rich-message.js";
import {
  buildTelegramPlainFallbackPlan,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";
import {
  createTelegramRequestWithDiag,
  isTelegramMessageHasNoTextError,
  isTelegramMessageNotModifiedError,
  normalizeMessageId,
  resolveAndPersistChatId,
  resolveTelegramApiContext,
  sendLogger,
  withTelegramApiContextLease,
  withTelegramHtmlParseFallback,
  type TelegramApiContext,
  type TelegramApiOverride,
} from "./send-context.js";
import type { OpenClawConfig } from "./send.runtime.js";
import { resolveMarkdownTableMode } from "./send.runtime.js";

type TelegramEditMessageTextParams = Parameters<TelegramApiContext["api"]["editMessageText"]>[3];
type TelegramEditMessageCaptionParams = Parameters<
  TelegramApiContext["api"]["editMessageCaption"]
>[2];

type TelegramEditOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  textMode?: "markdown" | "html";
  /** Controls whether link previews are shown in the edited message. */
  linkPreview?: boolean;
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons;
  /** Use Telegram's media-caption edit endpoint, or fall back to it when text edits target media. */
  editMode?: "text" | "caption" | "auto";
  /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
};

type TelegramEditReplyMarkupOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons;
  /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
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
  const { cfg, account, api } = context;
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const replyMarkup = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
  try {
    await requestWithDiag(
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
  const rawTarget = String(chatIdInput);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: rawTarget,
    persistTarget: rawTarget,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const messageId = normalizeMessageId(messageIdInput);
  const requestWithDiag = createTelegramRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    shouldRetry: (err) =>
      isRecoverableTelegramNetworkError(err, { context: "edit" }) || isTelegramServerError(err),
  });
  const requestWithEditShouldLog = <T>(
    fn: () => Promise<T>,
    label?: string,
    shouldLog?: (err: unknown) => boolean,
  ) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : undefined);

  const textMode = opts.textMode ?? "markdown";
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
  const richRawApi = useRichMessages ? getTelegramRichRawApi(api) : undefined;
  const richMessagePlan = useRichMessages
    ? buildTelegramRichMarkdownPlan(text, {
        skipEntityDetection: opts.linkPreview === false,
        tableMode,
      })
    : undefined;

  // Reply markup semantics:
  // - buttons === undefined → don't send reply_markup (keep existing)
  // - buttons is [] (or filters to empty) → send { inline_keyboard: [] } (remove)
  // - otherwise → send built inline keyboard
  const shouldTouchButtons = opts.buttons !== undefined;
  const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : undefined;
  const replyMarkup = shouldTouchButtons ? (builtKeyboard ?? { inline_keyboard: [] }) : undefined;

  const textEditParams: TelegramEditMessageTextParams = {
    parse_mode: "HTML",
  };
  if (opts.linkPreview === false) {
    textEditParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    textEditParams.reply_markup = replyMarkup;
  }
  const plainTextParams: TelegramEditMessageTextParams = {};
  if (opts.linkPreview === false) {
    plainTextParams.link_preview_options = { is_disabled: true };
  }
  if (replyMarkup !== undefined) {
    plainTextParams.reply_markup = replyMarkup;
  }
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

  const performTextEdit = () => {
    if (richRawApi && richMessagePlan) {
      const richEditParams: Pick<TelegramEditRichMessageTextParams, "reply_markup"> =
        replyMarkup === undefined ? {} : { reply_markup: replyMarkup };
      warnTelegramRichBlocksDegradations({
        context: "editMessage",
        reasons: richMessagePlan.degradationReasons,
        warn: (message) => sendLogger.warn(message),
      });
      return requestWithEditShouldLog(
        () =>
          richRawApi.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            rich_message: richMessagePlan.richMessage,
            ...richEditParams,
          }),
        "editMessage",
        (err) => !isTelegramMessageNotModifiedError(err),
      ).catch((err: unknown) => {
        const fallbackPlan = buildTelegramPlainFallbackPlan({
          plainText: richMessagePlan.plainText,
          err,
          context: "editMessage",
          warn: (message) => sendLogger.warn(message),
        });
        if (!fallbackPlan) {
          throw err;
        }
        return requestWithEditShouldLog(
          () =>
            Object.keys(plainTextParams).length > 0
              ? api.editMessageText(chatId, messageId, fallbackPlan.plainText, plainTextParams)
              : api.editMessageText(chatId, messageId, fallbackPlan.plainText),
          "editMessage-plain",
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        );
      });
    }
    return withTelegramHtmlParseFallback({
      label: "editMessage",
      verbose: opts.verbose,
      requestHtml: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageText(chatId, messageId, htmlText, textEditParams),
          retryLabel,
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      requestPlain: (retryLabel) =>
        requestWithEditShouldLog(
          () =>
            Object.keys(plainTextParams).length > 0
              ? api.editMessageText(chatId, messageId, plainText, plainTextParams)
              : api.editMessageText(chatId, messageId, plainText),
          retryLabel,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });
  };

  const performCaptionEdit = () =>
    withTelegramHtmlParseFallback({
      label: "editMessageCaption",
      verbose: opts.verbose,
      requestHtml: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageCaption(chatId, messageId, captionEditParams),
          retryLabel,
          (err) => !isTelegramMessageNotModifiedError(err),
        ),
      requestPlain: (retryLabel) =>
        requestWithEditShouldLog(
          () => api.editMessageCaption(chatId, messageId, plainCaptionParams),
          retryLabel,
          (plainErr) => !isTelegramMessageNotModifiedError(plainErr),
        ),
    });

  try {
    const editMode = opts.editMode ?? "text";
    if (editMode === "caption") {
      await performCaptionEdit();
    } else {
      try {
        await performTextEdit();
      } catch (err) {
        if (editMode === "auto" && isTelegramMessageHasNoTextError(err)) {
          await performCaptionEdit();
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

  logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
  return { ok: true, messageId: String(messageId), chatId };
}
