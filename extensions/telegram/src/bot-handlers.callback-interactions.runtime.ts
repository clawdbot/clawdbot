import type { CallbackQuery, Message } from "grammy/types";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type {
  TelegramCallbackButton,
  TelegramCallbackMessageActions,
} from "./bot-handlers.callback-actions.runtime.js";
import { TelegramRetryableCallbackError } from "./bot-handlers.callback-errors.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { withResolvedTelegramForumFlag } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { dispatchTelegramPluginInteractiveHandler } from "./interactive-dispatch.js";
import { buildInlineKeyboard } from "./send.js";

const MULTI_SELECT_PREFIX = "OC_MULTI|";
const MULTI_SELECT_TOGGLE_PREFIX = `${MULTI_SELECT_PREFIX}toggle|`;
const SELECT_PREFIX = "OC_SELECT|";
const SELECTED_PREFIX = "✅ ";
const TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS = [250, 1000, 2500] as const;
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

type TelegramManagedSelectCallback =
  | { type: "multi-toggle"; value: string }
  | { type: "multi-clear" }
  | { type: "multi-submit" }
  | { type: "select"; value: string };

const parseTelegramManagedSelectCallback = (
  data: string,
): TelegramManagedSelectCallback | undefined => {
  if (data.startsWith(MULTI_SELECT_TOGGLE_PREFIX)) {
    return { type: "multi-toggle", value: data.slice(MULTI_SELECT_TOGGLE_PREFIX.length) };
  }
  if (data === `${MULTI_SELECT_PREFIX}clear`) {
    return { type: "multi-clear" };
  }
  if (data === `${MULTI_SELECT_PREFIX}submit`) {
    return { type: "multi-submit" };
  }
  if (data.startsWith(SELECT_PREFIX)) {
    return { type: "select", value: data.slice(SELECT_PREFIX.length) };
  }
  return undefined;
};

const cloneInlineKeyboardButtons = (message: Message): TelegramCallbackButton[][] => {
  const rows = (message as { reply_markup?: { inline_keyboard?: unknown } }).reply_markup
    ?.inline_keyboard;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) =>
      Array.isArray(row)
        ? row
            .map((button): TelegramCallbackButton | null => {
              const candidate = button as {
                text?: unknown;
                callback_data?: unknown;
                style?: unknown;
              };
              if (
                typeof candidate.text !== "string" ||
                typeof candidate.callback_data !== "string"
              ) {
                return null;
              }
              const style =
                candidate.style === "danger" ||
                candidate.style === "success" ||
                candidate.style === "primary"
                  ? candidate.style
                  : undefined;
              return {
                text: candidate.text,
                callback_data: candidate.callback_data,
                ...(style ? { style } : {}),
              };
            })
            .filter((button): button is TelegramCallbackButton => button !== null)
        : [],
    )
    .filter((row) => row.length > 0);
};

const stripMultiSelectPrefix = (text: string): string => text.replace(/^✅\s*/, "");
const isSelectedMultiButton = (button: TelegramCallbackButton): boolean =>
  /^✅\s*/.test(button.text);
const isMultiToggleButton = (button: TelegramCallbackButton): boolean =>
  button.callback_data.startsWith(MULTI_SELECT_TOGGLE_PREFIX);
const resolveMultiSelectedValues = (buttons: TelegramCallbackButton[][]): string[] =>
  buttons.flatMap((row) =>
    row.flatMap((button) => {
      if (!isMultiToggleButton(button) || !isSelectedMultiButton(button)) {
        return [];
      }
      return [button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length)];
    }),
  );
const updateMultiSelectKeyboard = (
  message: Message,
  action: "toggle" | "clear",
  value = "",
): TelegramCallbackButton[][] =>
  cloneInlineKeyboardButtons(message).map((row) =>
    row.map((button) => {
      if (!isMultiToggleButton(button)) {
        return button;
      }
      const buttonValue = button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length);
      const baseText = stripMultiSelectPrefix(button.text);
      const selected =
        action === "clear"
          ? false
          : buttonValue === value
            ? !isSelectedMultiButton(button)
            : isSelectedMultiButton(button);
      return { ...button, text: selected ? `${SELECTED_PREFIX}${baseText}` : baseText };
    }),
  );

const resolvePluginCallbackSubmitText = (submitText: unknown): string | undefined => {
  if (typeof submitText !== "string") {
    return undefined;
  }
  const trimmed = submitText.trim();
  return trimmed ? trimmed : undefined;
};

const isReplySessionInitConflictError = (err: unknown): boolean =>
  REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(String(err instanceof Error ? err.message : err));

const isReplySessionInitConflictResult = (result: TelegramMessageProcessingResult): boolean =>
  result.kind === "failed-retryable" && isReplySessionInitConflictError(result.error);

export async function handleTelegramInteractiveCallback(params: {
  accountId: RegisterTelegramHandlerParams["accountId"];
  callback: CallbackQuery;
  ctx: Pick<TelegramContext, "me" | "getFile">;
  callbackMessage: Message;
  data: string;
  pluginCallbackData: string;
  callbackConversationId: string;
  callbackThreadId?: number;
  senderId: string;
  senderUsername: string;
  isGroup: boolean;
  isForum: boolean;
  storeAllowFrom: Parameters<
    TelegramHandlerMessageRuntime["processMessageWithReplyChain"]
  >[0]["storeAllowFrom"];
  actions: TelegramCallbackMessageActions;
  messageRuntime: TelegramHandlerMessageRuntime;
  authorizeCallback: () => Promise<boolean>;
}): Promise<boolean> {
  const {
    accountId,
    callback,
    ctx,
    callbackMessage,
    data,
    pluginCallbackData,
    callbackConversationId,
    callbackThreadId,
    senderId,
    senderUsername,
    isGroup,
    isForum,
    storeAllowFrom,
    actions,
    messageRuntime,
    authorizeCallback,
  } = params;
  const {
    buildSyntheticTextMessage,
    buildSyntheticContext,
    buildFailedProcessingResult,
    processMessageWithReplyChain,
  } = messageRuntime;
  const {
    clearCallbackButtons,
    editCallbackButtons,
    editCallbackMessage,
    deleteCallbackMessage,
    replyToCallbackChat,
  } = actions;
  const buildSynthetic = (text: string) => {
    const message = buildSyntheticTextMessage({
      base: withResolvedTelegramForumFlag(callbackMessage, isForum),
      from: callback.from,
      text,
    });
    return { ctx: buildSyntheticContext(ctx, message), message };
  };
  const processSubmitText = async (text: string): Promise<"completed" | "skipped"> => {
    const synthetic = buildSynthetic(text);
    const participant = isTelegramSpooledReplayUpdate(synthetic.ctx.update)
      ? (getTelegramSpooledReplayDeferredParticipant() ??
        createTelegramSpooledReplayDeferredParticipant(`plugin-callback-submit:${callback.id}`) ??
        undefined)
      : undefined;
    const settle = (result: TelegramMessageProcessingResult) => {
      participant?.settle(result);
      return result.kind;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await processMessageWithReplyChain({
          ctx: synthetic.ctx,
          msg: synthetic.message,
          allMedia: [],
          storeAllowFrom,
          options: {
            spooledReplay: true,
            isolateSpooledReplaySettlement: true,
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          },
          spooledReplayAbortSignal: participant?.abortSignal,
        });
        if (result.kind === "completed" || result.kind === "skipped") {
          settle(result);
          return result.kind;
        }
        const retryDelayMs = TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS[attempt];
        if (!isReplySessionInitConflictResult(result) || retryDelayMs === undefined) {
          throw new TelegramRetryableCallbackError(result.error);
        }
        logVerbose(
          `telegram plugin callback submitText hit active reply session; retrying in ${retryDelayMs}ms`,
        );
        await sleepWithAbort(retryDelayMs, participant?.abortSignal);
      } catch (err) {
        const retryDelayMs = TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS[attempt];
        if (!isReplySessionInitConflictError(err) || retryDelayMs === undefined) {
          settle(buildFailedProcessingResult(err));
          throw err;
        }
        logVerbose(
          `telegram plugin callback submitText hit active reply session; retrying in ${retryDelayMs}ms`,
        );
        await sleepWithAbort(retryDelayMs, participant?.abortSignal);
      }
    }
  };

  const pluginBindingApproval = parsePluginBindingApprovalCustomId(data);
  if (pluginBindingApproval) {
    let resolved: Awaited<ReturnType<typeof resolvePluginConversationBindingApproval>>;
    try {
      resolved = await resolvePluginConversationBindingApproval({
        approvalId: pluginBindingApproval.approvalId,
        decision: pluginBindingApproval.decision,
        senderId: senderId || undefined,
      });
    } catch (err) {
      throw new TelegramRetryableCallbackError(err);
    }
    await clearCallbackButtons();
    await replyToCallbackChat(buildPluginBindingResolvedText(resolved));
    return true;
  }

  const pluginCallback = await dispatchTelegramPluginInteractiveHandler({
    data: pluginCallbackData,
    callbackId: callback.id,
    ctx: {
      accountId,
      callbackId: callback.id,
      conversationId: callbackConversationId,
      parentConversationId: callbackThreadId != null ? String(callbackMessage.chat.id) : undefined,
      senderId: senderId || undefined,
      senderUsername: senderUsername || undefined,
      threadId: callbackThreadId,
      isGroup,
      isForum,
      auth: { isAuthorizedSender: await authorizeCallback() },
      callbackMessage: {
        messageId: callbackMessage.message_id,
        chatId: String(callbackMessage.chat.id),
        messageText: callbackMessage.text ?? callbackMessage.caption,
      },
    },
    respond: {
      reply: async ({ text, buttons }) => {
        await replyToCallbackChat(
          text,
          buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
        );
      },
      editMessage: async ({ text, buttons }) => {
        await editCallbackMessage(
          text,
          buttons ? { reply_markup: buildInlineKeyboard(buttons) } : undefined,
        );
      },
      editButtons: async ({ buttons }) => {
        await editCallbackButtons(buttons);
      },
      clearButtons: async () => {
        await clearCallbackButtons();
      },
      deleteMessage: async () => {
        await deleteCallbackMessage();
      },
    },
    afterInvoke: async (result) => {
      if (result?.handled === false) {
        return;
      }
      const submitText = resolvePluginCallbackSubmitText(result?.submitText);
      if (!submitText || (await processSubmitText(submitText)) === "skipped") {
        return;
      }
      await clearCallbackButtons().catch((err: unknown) => {
        logVerbose(`telegram plugin callback button cleanup skipped: ${String(err)}`);
      });
    },
  });
  if (pluginCallback.handled) {
    return true;
  }

  const managedSelectCallback = parseTelegramManagedSelectCallback(data);
  if (!managedSelectCallback) {
    return false;
  }
  if (
    managedSelectCallback.type === "multi-toggle" ||
    managedSelectCallback.type === "multi-clear"
  ) {
    const buttons = updateMultiSelectKeyboard(
      callbackMessage,
      managedSelectCallback.type === "multi-clear" ? "clear" : "toggle",
      managedSelectCallback.type === "multi-toggle" ? managedSelectCallback.value : "",
    );
    if (buttons.length > 0) {
      try {
        await editCallbackButtons(buttons);
      } catch (editErr) {
        if (!String(editErr).includes("message is not modified")) {
          throw new TelegramRetryableCallbackError(editErr);
        }
      }
    }
    return true;
  }

  let text: string;
  if (managedSelectCallback.type === "multi-submit") {
    const selected = resolveMultiSelectedValues(cloneInlineKeyboardButtons(callbackMessage));
    text = `Multi-select submitted: ${selected.length > 0 ? selected.join(", ") : "none"}`;
  } else {
    try {
      await clearCallbackButtons();
    } catch (editErr) {
      const errStr = String(editErr);
      if (
        !errStr.includes("message is not modified") &&
        !errStr.includes("there is no text in the message to edit")
      ) {
        throw new TelegramRetryableCallbackError(editErr);
      }
    }
    text = `Single-select submitted: ${managedSelectCallback.value}`;
  }
  const synthetic = buildSynthetic(text);
  await processMessageWithReplyChain({
    ctx: synthetic.ctx,
    msg: synthetic.message,
    allMedia: [],
    storeAllowFrom,
    options: { forceWasMentioned: true, messageIdOverride: callback.id },
  });
  return true;
}
