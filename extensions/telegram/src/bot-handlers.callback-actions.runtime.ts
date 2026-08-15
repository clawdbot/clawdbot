import type { Message } from "grammy/types";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { buildTelegramThreadParams, resolveTelegramThreadSpec } from "./bot/helpers.js";
import { isTelegramMessageNotModifiedError } from "./network-errors.js";
import { buildTelegramRichMarkdown, getTelegramRichRawApi } from "./rich-message.js";
import { buildInlineKeyboard } from "./send.js";

export type TelegramCallbackButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};

export interface TelegramCallbackMessageActions {
  editCallbackMessage: (
    text: string,
    editParams?: Parameters<RegisterTelegramHandlerParams["bot"]["api"]["editMessageText"]>[3],
  ) => ReturnType<RegisterTelegramHandlerParams["bot"]["api"]["editMessageText"]>;
  clearCallbackButtons: () => ReturnType<
    RegisterTelegramHandlerParams["bot"]["api"]["editMessageReplyMarkup"]
  >;
  editCallbackButtons: (
    buttons: TelegramCallbackButton[][],
  ) => ReturnType<RegisterTelegramHandlerParams["bot"]["api"]["editMessageReplyMarkup"]>;
  deleteCallbackMessage: () => ReturnType<
    RegisterTelegramHandlerParams["bot"]["api"]["deleteMessage"]
  >;
  replyToCallbackChat: (
    text: string,
    replyParams?: Parameters<RegisterTelegramHandlerParams["bot"]["api"]["sendMessage"]>[2],
  ) => ReturnType<RegisterTelegramHandlerParams["bot"]["api"]["sendMessage"]>;
}

export function createTelegramCallbackMessageActions(params: {
  bot: RegisterTelegramHandlerParams["bot"];
  callbackMessage: Message;
  isGroup: boolean;
  isForum: boolean;
  richMessages?: boolean;
}): TelegramCallbackMessageActions {
  const { bot, callbackMessage, isGroup, isForum, richMessages = false } = params;
  const callbackBusinessParams =
    callbackMessage.business_connection_id !== undefined
      ? { business_connection_id: callbackMessage.business_connection_id }
      : undefined;
  const withCallbackBusinessParams = <T extends object>(value: T) =>
    callbackBusinessParams ? { ...callbackBusinessParams, ...value } : value;

  const editCallbackMessage = async (
    text: string,
    editParams?: Parameters<typeof bot.api.editMessageText>[3],
  ) => {
    // Rich-enabled accounts send picker messages through the rich raw API.
    // Editing that same message through the legacy text path makes Telegram
    // for iOS render the new body over the stale rich body. Mirror the rich
    // send path for callback edits, keeping caller-authored HTML edits on
    // the legacy parse_mode HTML funnel (rich wire path is blocks-only).
    if (
      richMessages &&
      editParams?.parse_mode !== "HTML" &&
      (bot.api as { raw?: unknown }).raw !== undefined
    ) {
      const richRawApi = getTelegramRichRawApi(bot.api);
      const richMessage = buildTelegramRichMarkdown(text);
      try {
        const richEditParams = {
          chat_id: callbackMessage.chat.id,
          message_id: callbackMessage.message_id,
          rich_message: richMessage,
          ...(editParams?.reply_markup !== undefined
            ? { reply_markup: editParams.reply_markup }
            : {}),
        };
        return (await richRawApi.editMessageText(
          callbackBusinessParams ? withCallbackBusinessParams(richEditParams) : richEditParams,
        )) as unknown as Awaited<ReturnType<typeof bot.api.editMessageText>>;
      } catch (richErr) {
        // "message is not modified" is expected for idempotent picker edits.
        if (isTelegramMessageNotModifiedError(richErr)) {
          throw richErr;
        }
        // Fall back to the legacy text edit, mirroring the rich-send funnel.
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          editParams ? withCallbackBusinessParams(editParams) : callbackBusinessParams,
        );
      }
    }
    return await bot.api.editMessageText(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      text,
      editParams ? withCallbackBusinessParams(editParams) : callbackBusinessParams,
    );
  };

  const clearCallbackButtons = async () => {
    return await bot.api.editMessageReplyMarkup(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      withCallbackBusinessParams({ reply_markup: { inline_keyboard: [] } }),
    );
  };

  const editCallbackButtons = async (buttons: TelegramCallbackButton[][]) => {
    return await bot.api.editMessageReplyMarkup(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      withCallbackBusinessParams({
        reply_markup: buildInlineKeyboard(buttons) ?? { inline_keyboard: [] },
      }),
    );
  };

  const deleteCallbackMessage = async () => {
    return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
  };

  const replyToCallbackChat = async (
    text: string,
    replyParams?: Parameters<typeof bot.api.sendMessage>[2],
  ) => {
    const threadParams = buildTelegramThreadParams(
      resolveTelegramThreadSpec({
        isGroup,
        isForum,
        messageThreadId: callbackMessage.message_thread_id,
      }),
    );
    const topicParams = {
      ...callbackBusinessParams,
      ...threadParams,
      ...(callbackMessage.direct_messages_topic?.topic_id != null
        ? { direct_messages_topic_id: callbackMessage.direct_messages_topic.topic_id }
        : {}),
    };
    const mergedParams =
      Object.keys(topicParams).length > 0 || replyParams
        ? { ...topicParams, ...replyParams }
        : replyParams;
    return await bot.api.sendMessage(callbackMessage.chat.id, text, mergedParams);
  };

  return {
    editCallbackMessage,
    clearCallbackButtons,
    editCallbackButtons,
    deleteCallbackMessage,
    replyToCallbackChat,
  };
}
