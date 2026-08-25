import type { Context } from "grammy";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import {
  createTelegramCallbackMessageActions,
  handleTelegramQuestionCallback,
} from "./bot-handlers.callback-actions.js";
import {
  createTelegramCallbackApprovalRuntime,
  handleTelegramInteractiveCallback,
  isPermanentTelegramCallbackEditError,
  type TelegramCallbackMessageRuntime,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-router-controls.js";
import type {
  TelegramEventAuthorizationMode,
  TelegramHandlerAuthorization,
} from "./bot-handlers.inbound-authorization.js";
import { handleTelegramModelCallback } from "./bot-handlers.model-callback.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramCallbackRouter,
} from "./bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  resolveTelegramForumFlag,
  resolveTelegramMessageThreadSpec,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import { getTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  hasTelegramOpaqueCallbackPrefix,
  parseTelegramNativeCommandCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { isTelegramMessageNotModifiedError } from "./network-errors.js";
import {
  hasTelegramQuestionCallbackPrefix,
  parseTelegramQuestionCallbackData,
} from "./question-callback-data.js";
import { buildTelegramConversationId } from "./topic-conversation.js";

export function createTelegramCallbackRouter({
  params: {
    accountId,
    bot,
    runtime,
    telegramDeps,
    shouldSkipUpdate,
    nativeCommandCallbackDispatcher,
  },
  message: messageRuntime,
  authorization: authorizationRuntime,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramCallbackMessageRuntime;
  authorization: TelegramHandlerAuthorization;
}): TelegramCallbackRouter {
  const { buildSyntheticTextMessage, buildSyntheticContext, processMessageWithReplyChain } =
    messageRuntime;
  const {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
  } = authorizationRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);

  const handleCallback = async (ctx: Context) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    let callbackAnswered = false;
    const answerCallbackQuery = async (text?: string) => {
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () =>
          text
            ? bot.api.answerCallbackQuery(callback.id, { text })
            : bot.api.answerCallbackQuery(callback.id),
      }).catch(() => {});
      callbackAnswered = true;
    };
    if (shouldSkipUpdate(ctx)) {
      const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
      if (earlyAnswerPromise) {
        await earlyAnswerPromise.catch(async () => await answerCallbackQuery());
      } else {
        await answerCallbackQuery();
      }
      return;
    }
    const data = (callback.data ?? "").trim();
    const typedQuestionCallback = parseTelegramQuestionCallbackData(data);
    const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
    if (earlyAnswerPromise) {
      try {
        await earlyAnswerPromise;
        callbackAnswered = true;
      } catch {
        await answerCallbackQuery();
      }
    } else {
      await answerCallbackQuery();
    }

    try {
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const hasReservedOpaquePrefix = hasTelegramOpaqueCallbackPrefix(data);
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(callback.data?.trimStart());
      const genericCallbackText = data.startsWith("/") ? data : `callback_data: ${data}`;
      const callbackCommandText =
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : genericCallbackText);
      const hasReservedApprovalPrefix = hasTelegramApprovalCallbackPrefix(data);
      const hasReservedQuestionPrefix = hasTelegramQuestionCallbackPrefix(data);
      const typedApprovalCallback = parseTelegramApprovalCallbackData(data);
      const legacyApprovalCallback = parseExecApprovalCommandText(
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : data),
      );
      const isApprovalCallback = hasReservedApprovalPrefix || legacyApprovalCallback !== null;
      const isRuntimeControlCallback = isApprovalCallback || hasReservedQuestionPrefix;
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: authorizationCfg,
        accountId,
      });
      const inlineButtonsUnavailable =
        inlineButtonsScope === "off" ||
        (inlineButtonsScope === "dm" && isGroup) ||
        (inlineButtonsScope === "group" && !isGroup);
      // Runtime controls retain their authorization after inline-button capability changes.
      // Stale typed controls cross this gate only to render their terminal result.
      if (
        !isRuntimeControlCallback &&
        inlineButtonsUnavailable &&
        !nativeCallbackCommand &&
        !hasReservedOpaquePrefix
      ) {
        return;
      }

      const isForum = await resolveTelegramForumFlag({
        chatId,
        chatType: callbackMessage.chat.type,
        isGroup,
        isForum: callbackMessage.chat.is_forum,
        isTopicMessage: callbackMessage.is_topic_message,
        getChat,
      });
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        senderId,
        threadSpec: resolveTelegramMessageThreadSpec(callbackMessage, isForum),
      });
      const threadSpec = eventAuthContext.threadSpec;
      const { dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const actions = createTelegramCallbackMessageActions({
        bot,
        callbackMessage,
        threadSpec,
        richMessages: mergeTelegramAccountConfig(authorizationCfg, accountId).richMessages === true,
      });
      const clearRoutedCallbackButtons = async () => {
        try {
          await actions.clearCallbackButtons();
        } catch (editErr) {
          if (
            !isTelegramMessageNotModifiedError(editErr) &&
            !isPermanentTelegramCallbackEditError(editErr)
          ) {
            throw new TelegramRetryableCallbackError(editErr);
          }
        }
      };
      const terminalizeUnavailableCallback = async () => {
        logVerbose("telegram: typed callback unavailable (handler missing or payload invalid)");
        await clearRoutedCallbackButtons();
        await actions.replyToCallbackChat("This action is no longer available.");
      };

      if (
        inlineButtonsUnavailable &&
        ((nativeCallbackCommand && !legacyApprovalCallback) || hasReservedOpaquePrefix)
      ) {
        await terminalizeUnavailableCallback();
        return;
      }
      if (nativeCallbackCommand && nativeCommandCallbackDispatcher) {
        const dispatch = await nativeCommandCallbackDispatcher({
          botUser: ctx.me,
          callbackQuery: callback,
          commandText: nativeCallbackCommand,
        });
        if (dispatch.handled) {
          if (dispatch.clearButtons) {
            await clearRoutedCallbackButtons();
          }
          return;
        }
      }
      const authorizationMode: TelegramEventAuthorizationMode = hasReservedQuestionPrefix
        ? "callback-runtime-allowlist"
        : !isGroup || (!isRuntimeControlCallback && inlineButtonsScope === "allowlist")
          ? "callback-allowlist"
          : "callback-scope";
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
        return;
      }

      const callbackConversationId = buildTelegramConversationId({ chatId, thread: threadSpec });
      const callbackThreadId = threadSpec.id;
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const approvalRuntime = createTelegramCallbackApprovalRuntime({
        accountId,
        telegramDeps,
        runtimeCfg,
        senderId,
        actions,
      });
      const authorizeCallback = async () =>
        await isTelegramModelCallbackAuthorized({
          chatId,
          isGroup,
          senderId,
          senderUsername,
          context: eventAuthContext,
        });
      if (typedApprovalCallback) {
        await approvalRuntime.handleCanonical(typedApprovalCallback);
        return;
      }
      if (typedQuestionCallback) {
        await handleTelegramQuestionCallback({
          callback: typedQuestionCallback,
          cfg: runtimeCfg,
          senderId,
          feedback: async (text, terminal) => {
            if (terminal) {
              await actions.clearCallbackButtons().catch(() => {});
            }
            await actions.replyToCallbackChat(text);
          },
        });
        return;
      }
      if (hasReservedQuestionPrefix) {
        return;
      }
      if (hasReservedApprovalPrefix) {
        await approvalRuntime.handleMalformedReserved();
        return;
      }
      if (
        !nativeCallbackCommand &&
        !inlineButtonsUnavailable &&
        (await handleTelegramInteractiveCallback({
          accountId,
          callback,
          ctx,
          callbackMessage,
          data,
          pluginCallbackData: opaqueCallbackData ?? data,
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
        }))
      ) {
        return;
      }
      if (legacyApprovalCallback) {
        await approvalRuntime.handleLegacy(legacyApprovalCallback);
        return;
      }
      if (hasReservedOpaquePrefix) {
        await terminalizeUnavailableCallback();
        return;
      }
      if (
        await handleTelegramModelCallback({
          data,
          ctx,
          chatId,
          isGroup,
          threadSpec,
          senderId,
          runtimeCfg,
          telegramDeps,
          actions,
          messageRuntime,
          authorizeCallback,
        })
      ) {
        return;
      }

      const hasCallbackInlineKeyboard =
        (callbackMessage.reply_markup?.inline_keyboard?.length ?? 0) > 0;
      if (hasCallbackInlineKeyboard) {
        await clearRoutedCallbackButtons();
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: withResolvedTelegramForumFlag(callbackMessage, isForum),
        from: callback.from,
        text: callbackCommandText,
      });
      const syntheticCtx = buildSyntheticContext(ctx, syntheticMessage);
      await processMessageWithReplyChain({
        ctx: syntheticCtx,
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom,
        options: {
          threadSpec,
          ...(nativeCallbackCommand ? { commandSource: "native" as const } : {}),
          forceWasMentioned: true,
          messageIdOverride: callback.id,
        },
      });
    } catch (err) {
      if (err instanceof TelegramRetryableCallbackError) {
        if (isPermanentTelegramCallbackEditError(err.cause)) {
          logVerbose(`telegram: swallowing permanent callback edit error: ${String(err.cause)}`);
          return;
        }
        runtime.error?.(danger(`callback handler failed: ${String(err)}`));
        throw err.cause;
      }
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
      }
    } finally {
      if (typedQuestionCallback && !callbackAnswered) {
        await answerCallbackQuery();
      }
    }
  };

  return {
    route: async (ctx) => {
      if (!ctx.callbackQuery) {
        return { kind: "ignored" };
      }
      await handleCallback(ctx);
      return { kind: "handled" };
    },
  };
}
