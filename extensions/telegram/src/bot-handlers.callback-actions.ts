import type { Message, User } from "grammy/types";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
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
  threadSpec: TelegramThreadSpec;
}): TelegramCallbackMessageActions {
  const { bot, callbackMessage, threadSpec } = params;
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

/** Confirms a terminal result without replaying its action after a delivery failure. */
export async function sendTelegramCallbackTerminalReceipt(params: {
  actions: TelegramCallbackMessageActions;
  text: string;
  extra?: Parameters<TelegramCallbackMessageActions["editCallbackMessageWithButtons"]>[2];
  reportError?: (message: string) => void;
}): Promise<void> {
  const { actions, text, extra, reportError = logVerbose } = params;
  try {
    await actions.editCallbackMessage(text, {
      reply_markup: { inline_keyboard: [] },
      ...extra,
    });
    return;
  } catch (editErr) {
    const errStr = String(editErr);
    const alreadyTerminal = errStr.includes("message is not modified");
    if (!alreadyTerminal) {
      reportError(`telegram: failed to render terminal callback receipt: ${errStr}`);
    }
    // Retire stale controls even when another surface committed the terminal result.
    // Delivery failure must not replay an action whose outcome is already authoritative.
    await actions.clearCallbackButtons().catch((error: unknown) => {
      const message = String(error);
      if (
        !message.includes("message is not modified") &&
        !message.includes("there is no text in the message to edit")
      ) {
        reportError(`telegram: failed to clear terminal callback buttons: ${message}`);
      }
    });
    if (alreadyTerminal) {
      return;
    }
  }
  await actions.replyToCallbackChat(text, extra).catch((error: unknown) => {
    reportError(`telegram: failed to send terminal callback receipt: ${String(error)}`);
  });
}

type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionResolver = (
  params: ResolveQuestionParams,
) => ReturnType<typeof questionGatewayRuntime.resolveOption>;
type QuestionFeedbackMode = "terminal" | "retry" | "custom-input";

export async function sendTelegramQuestionFeedback(params: {
  actions: TelegramCallbackMessageActions;
  text: string;
  mode: QuestionFeedbackMode;
  isGroup: boolean;
  user: User;
}): Promise<void> {
  if (params.mode === "terminal") {
    await params.actions.clearCallbackButtons().catch(() => {});
  }
  const groupCustomInput = params.mode === "custom-input" && params.isGroup;
  const text = groupCustomInput
    ? `${params.user.first_name}, reply with your own answer.`
    : params.text;
  await params.actions.replyToCallbackChat(
    text,
    params.mode === "custom-input"
      ? {
          ...(groupCustomInput
            ? {
                // Selective Force Reply targets mentioned users or the sender of the
                // replied-to message. The question is bot-authored, so mention the tapper.
                entities: [
                  {
                    type: "text_mention" as const,
                    offset: 0,
                    length: params.user.first_name.length,
                    user: params.user,
                  },
                ],
              }
            : {}),
          reply_markup: { force_reply: true, selective: groupCustomInput },
        }
      : undefined,
  );
  if (params.mode === "custom-input") {
    // Keep the existing answer route until Telegram accepts its replacement.
    await params.actions.clearCallbackButtons().catch(() => {});
  }
}

export async function handleTelegramQuestionCallback(params: {
  callback: TelegramQuestionCallback;
  cfg: ResolveQuestionParams["cfg"];
  senderId: string;
  feedback: (text: string, mode: QuestionFeedbackMode) => Promise<unknown>;
  resolveQuestion?: QuestionResolver;
}): Promise<void> {
  try {
    if (params.callback.intent === "custom-input") {
      const result = await (params.resolveQuestion ?? questionGatewayRuntime.resolveOption)({
        cfg: params.cfg,
        questionId: params.callback.questionId,
        customInput: true,
        senderId: params.senderId,
        clientDisplayName: "Telegram question",
      });
      if (result.status === "already-terminal") {
        await params.feedback("This question was already answered.", "terminal");
        return;
      }
      await params.feedback("Reply with your own answer.", "custom-input");
      return;
    }
    const result = await (params.resolveQuestion ?? questionGatewayRuntime.resolveOption)({
      cfg: params.cfg,
      questionId: params.callback.questionId,
      optionIndex: params.callback.optionIndex,
      senderId: params.senderId,
      clientDisplayName: "Telegram question",
    });
    await params
      .feedback(
        result.status === "answered" ? "Answer submitted." : "This question was already answered.",
        "terminal",
      )
      .catch(() => {});
  } catch (error) {
    await params.feedback("Could not submit this answer.", "retry").catch(() => {});
    throw error;
  }
}
