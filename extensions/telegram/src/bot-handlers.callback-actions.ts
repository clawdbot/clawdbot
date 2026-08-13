import type { Message } from "grammy/types";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramThreadParams, resolveTelegramMessageThreadSpec } from "./bot/helpers.js";
import type { TelegramQuestionCallback } from "./question-callback-data.js";
import { buildInlineKeyboard } from "./send.js";

export type TelegramCallbackButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};

type TelegramCallbackReplyParams = Omit<
  NonNullable<Parameters<RegisterTelegramHandlerParams["bot"]["api"]["sendMessage"]>[2]>,
  "direct_messages_topic_id" | "message_thread_id"
>;

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
  editCallbackMessageWithButtons: (
    text: string,
    buttons: TelegramCallbackButton[][],
    extra?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" },
  ) => Promise<void>;
  deleteCallbackMessage: () => ReturnType<
    RegisterTelegramHandlerParams["bot"]["api"]["deleteMessage"]
  >;
  replyToCallbackChat: (
    text: string,
    replyParams?: TelegramCallbackReplyParams,
  ) => ReturnType<RegisterTelegramHandlerParams["bot"]["api"]["sendMessage"]>;
}

export function createTelegramCallbackMessageActions(params: {
  bot: RegisterTelegramHandlerParams["bot"];
  callbackMessage: Message;
  isForum: boolean;
}): TelegramCallbackMessageActions {
  const { bot, callbackMessage, isForum } = params;
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

  const replyToCallbackChat = async (text: string, replyParams?: TelegramCallbackReplyParams) => {
    const threadParams = buildTelegramThreadParams(
      resolveTelegramMessageThreadSpec(callbackMessage, isForum),
    );
    const mergedParams =
      callbackBusinessParams || threadParams || replyParams
        ? { ...replyParams, ...callbackBusinessParams, ...threadParams }
        : replyParams;
    return await bot.api.sendMessage(callbackMessage.chat.id, text, mergedParams);
  };

  const editCallbackMessageWithButtons = async (
    text: string,
    buttons: TelegramCallbackButton[][],
    extra?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" },
  ) => {
    const keyboard = buildInlineKeyboard(buttons);
    const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
    try {
      await editCallbackMessage(text, editParams);
    } catch (editErr) {
      const errStr = String(editErr);
      if (errStr.includes("no text in the message")) {
        try {
          await deleteCallbackMessage();
        } catch {}
        await replyToCallbackChat(text, keyboard ? { reply_markup: keyboard, ...extra } : extra);
      } else if (!errStr.includes("message is not modified")) {
        throw editErr;
      }
    }
  };

  return {
    editCallbackMessage,
    clearCallbackButtons,
    editCallbackButtons,
    editCallbackMessageWithButtons,
    deleteCallbackMessage,
    replyToCallbackChat,
  };
}
type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionResolver = (
  params: ResolveQuestionParams,
) => ReturnType<typeof questionGatewayRuntime.resolveOption>;

export async function handleTelegramQuestionCallback(params: {
  callback: TelegramQuestionCallback;
  cfg: ResolveQuestionParams["cfg"];
  senderId: string;
  feedback: (text: string, terminal: boolean) => Promise<unknown>;
  resolveQuestion?: QuestionResolver;
}): Promise<void> {
  let result: Awaited<ReturnType<QuestionResolver>>;
  try {
    result = await (params.resolveQuestion ?? questionGatewayRuntime.resolveOption)({
      cfg: params.cfg,
      questionId: params.callback.questionId,
      optionIndex: params.callback.optionIndex,
      senderId: params.senderId,
      clientDisplayName: "Telegram question",
    });
  } catch (error) {
    await params.feedback("Could not submit this answer.", false).catch(() => {});
    throw error;
  }
  await params
    .feedback(
      result.status === "answered" ? "Answer submitted." : "This question was already answered.",
      true,
    )
    .catch(() => {});
}
