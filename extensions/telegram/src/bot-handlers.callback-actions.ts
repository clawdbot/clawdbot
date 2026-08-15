import type { InlineKeyboardMarkup, Message } from "grammy/types";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { isTelegramMessageNotModifiedError } from "./network-errors.js";
import type { TelegramQuestionCallback } from "./question-callback-data.js";
import type { InputRichBlock } from "./rich-block-model.js";
import {
  buildTelegramRichBlocksPlan,
  buildTelegramRichMarkdown,
  getTelegramRichRawApi,
} from "./rich-message.js";
import { buildInlineKeyboard } from "./send.js";

export type TelegramCallbackButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};

/**
 * Hand-built rich blocks for a caller-authored edit whose interpolated content
 * (e.g. a provider/model id) isn't guaranteed markdown-safe. Bypasses
 * `buildTelegramRichMarkdown`'s markdown parsing entirely — same pattern as
 * `progress-draft-preview.ts`'s `boldRichText`/`paragraphBlock` construction —
 * so odd characters in interpolated text can't corrupt formatting or be
 * silently swallowed by markdown link/emphasis parsing.
 */
export type TelegramCallbackRichTextOverride = {
  blocks: InputRichBlock[];
};

type TelegramCallbackReplyParams = Omit<
  NonNullable<Parameters<RegisterTelegramHandlerParams["bot"]["api"]["sendMessage"]>[2]>,
  "direct_messages_topic_id" | "message_thread_id"
>;

export interface TelegramCallbackMessageActions {
  editCallbackMessage: (
    text: string,
    editParams?: Parameters<RegisterTelegramHandlerParams["bot"]["api"]["editMessageText"]>[3],
    richTextOverride?: TelegramCallbackRichTextOverride,
  ) => Promise<Message | true>;
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
    richTextOverride?: TelegramCallbackRichTextOverride,
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
  threadSpec: TelegramThreadSpec;
  richMessages?: boolean;
}): TelegramCallbackMessageActions {
  const { bot, callbackMessage, threadSpec, richMessages = false } = params;
  const callbackBusinessParams =
    callbackMessage.business_connection_id !== undefined
      ? { business_connection_id: callbackMessage.business_connection_id }
      : undefined;
  const withCallbackBusinessParams = <T extends object>(value: T) =>
    callbackBusinessParams ? { ...callbackBusinessParams, ...value } : value;

  const legacyEditCallbackMessage = async (
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

  const editCallbackMessage = async (
    text: string,
    editParams?: Parameters<typeof bot.api.editMessageText>[3],
    richTextOverride?: TelegramCallbackRichTextOverride,
  ) => {
    // Rich accounts author HTML confirmations (e.g. the /model picker) directly on the
    // legacy funnel by default: the rich wire path is blocks-only and would re-escape
    // caller HTML. See the contract note in rich-message.ts above TelegramInputRichMessage.
    // A caller that supplies richTextOverride opts a specific parse_mode:"HTML" edit back
    // into the rich funnel with hand-built blocks instead — required whenever that edit
    // targets a message that was itself sent as rich (e.g. the /model picker's final
    // confirmation), since a legacy-text edit there leaves the prior rich body's markup
    // visible underneath the new plain text instead of fully replacing it.
    if (!richMessages || (editParams?.parse_mode === "HTML" && !richTextOverride)) {
      return await legacyEditCallbackMessage(text, editParams);
    }
    try {
      const richMessage = richTextOverride
        ? buildTelegramRichBlocksPlan(richTextOverride.blocks, { skipEntityDetection: true })
            .richMessage
        : buildTelegramRichMarkdown(text);
      return await getTelegramRichRawApi(bot.api).editMessageText(
        withCallbackBusinessParams({
          chat_id: callbackMessage.chat.id,
          message_id: callbackMessage.message_id,
          rich_message: richMessage,
          ...(editParams?.reply_markup
            ? { reply_markup: editParams.reply_markup as InlineKeyboardMarkup }
            : {}),
        }),
      );
    } catch (richErr) {
      // "message is not modified" is a real terminal outcome (the edit target already
      // shows this content); a legacy retry would either no-op or mask the same error
      // differently, so it must propagate untouched instead of falling back.
      if (isTelegramMessageNotModifiedError(richErr)) {
        throw richErr;
      }
      return await legacyEditCallbackMessage(text, editParams);
    }
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
    return callbackBusinessParams
      ? await bot.api.deleteBusinessMessages(callbackBusinessParams.business_connection_id, [
          callbackMessage.message_id,
        ])
      : await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
  };

  const replyToCallbackChat = async (text: string, replyParams?: TelegramCallbackReplyParams) => {
    const threadParams = buildTelegramThreadParams(threadSpec);
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
    richTextOverride?: TelegramCallbackRichTextOverride,
  ) => {
    const keyboard = buildInlineKeyboard(buttons);
    const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
    try {
      await editCallbackMessage(text, editParams, richTextOverride);
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
