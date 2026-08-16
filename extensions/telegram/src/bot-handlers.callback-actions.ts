import type { InlineKeyboardMarkup, Message } from "grammy/types";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { isTelegramMessageNotModifiedError } from "./network-errors.js";
import type { TelegramQuestionCallback } from "./question-callback-data.js";
import type { InputRichBlock } from "./rich-block-model.js";
import { buildTelegramRichBlocksPlan, getTelegramRichRawApi } from "./rich-message.js";
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
type TelegramCallbackRichTextOverride = {
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

  // Representation-safe fallback for a message that can no longer be edited in
  // place without leaving stale content behind: Telegram's "no text in the
  // message" edit rejection, or a rich-edit failure on a message that was
  // itself sent as rich (legacy-editing that leaves the prior rich body's
  // markup visible underneath the new text — the #123886 symptom). The
  // replacement is sent *before* the original is deleted: by the time this
  // runs, the underlying model selection is already applied, so if delete-
  // then-send deleted first and the send then failed, the user would be left
  // with neither the picker nor a confirmation despite the change having
  // taken effect — a silent-failure outcome (ClawSweeper follow-up finding on
  // #124222). Deleting only after a successful send keeps that failure mode
  // impossible; delete failures (e.g. insufficient rights, message already
  // gone) are swallowed since the new message already stands on its own.
  const deleteAndReplyCallbackMessage = async (
    text: string,
    replyParams?: TelegramCallbackReplyParams,
  ) => {
    const sent = await replyToCallbackChat(text, replyParams);
    try {
      await deleteCallbackMessage();
    } catch {}
    return sent;
  };

  const editCallbackMessage = async (
    text: string,
    editParams?: Parameters<typeof bot.api.editMessageText>[3],
    richTextOverride?: TelegramCallbackRichTextOverride,
  ) => {
    // Rich routing is opt-in per call, not a richMessages-account-wide default: only a
    // caller that supplies richTextOverride's hand-built blocks goes through the rich raw
    // API. Every other caller (approval receipts, plugin respond.editMessage, the model
    // picker's own intermediate pagination/list/error edits) stays on the legacy funnel and
    // sends its text unparsed, exactly as it did before richMessages existed. Without this
    // guard, `buildTelegramRichMarkdown(text)` used to run on arbitrary un-authored text for
    // every rich account, silently reinterpreting incidental `*`/`_`/backtick/`[` characters
    // as Markdown (#123886 follow-up finding). Opting in is required whenever an edit
    // targets a message that was itself sent as rich (e.g. the /model picker's final
    // confirmation), since a legacy-text edit there leaves the prior rich body's markup
    // visible underneath the new plain text instead of fully replacing it.
    if (!richMessages || !richTextOverride) {
      return await legacyEditCallbackMessage(text, editParams);
    }
    try {
      const richMessage = buildTelegramRichBlocksPlan(richTextOverride.blocks, {
        skipEntityDetection: true,
      }).richMessage;
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
      // A legacy retry is not safe here: richTextOverride is only ever supplied for a
      // message that was itself sent as rich, and this file's own invariant (see the
      // comment above) is that legacy-editing such a message leaves its prior rich body
      // visible underneath the new text — exactly the #123886 bug this override exists to
      // avoid. Delete-and-reply sidesteps that by never editing the rich-sent message.
      return await deleteAndReplyCallbackMessage(text, {
        ...(editParams?.reply_markup ? { reply_markup: editParams.reply_markup } : {}),
        ...(editParams?.parse_mode ? { parse_mode: editParams.parse_mode } : {}),
      });
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
    // deleteMessage has no business_connection_id parameter at all (unlike editMessageText/
    // sendMessage/editMessageReplyMarkup, which all accept one) -- Telegram's Bot API instead
    // exposes a dedicated method, deleteBusinessMessages(business_connection_id, message_ids),
    // for deleting a message sent on behalf of a business account. Calling plain deleteMessage
    // on a business callback's picker fails (ClawSweeper follow-up finding on #124222), so the
    // business case must switch methods entirely rather than merge in an extra param.
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
        await deleteAndReplyCallbackMessage(
          text,
          keyboard ? { reply_markup: keyboard, ...extra } : extra,
        );
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
