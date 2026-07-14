// Telegram callback-query routing across approvals, plugin actions, selects, commands, and models.
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import type {
  TelegramEventAuthorizationMode,
  TelegramHandlerAuthorizationRuntime,
} from "./bot-handlers.authorization.runtime.js";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.runtime.js";
import { createTelegramCallbackApprovalRuntime } from "./bot-handlers.callback-approvals.runtime.js";
import {
  isPermanentTelegramCallbackEditError,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-errors.runtime.js";
import { handleTelegramInteractiveCallback } from "./bot-handlers.callback-interactions.runtime.js";
import { handleTelegramModelCallback } from "./bot-handlers.callback-model.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import { parseTelegramNativeCommandCallbackData } from "./bot-native-commands.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveTelegramForumFlag, withResolvedTelegramForumFlag } from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import { getTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { parseTelegramOpaqueCallbackData } from "./native-command-callback-data.js";

export function registerTelegramCallbackQueryHandler(
  { accountId, bot, runtime, telegramDeps, shouldSkipUpdate }: RegisterTelegramHandlerParams,
  messageRuntime: TelegramHandlerMessageRuntime,
  authorizationRuntime: TelegramHandlerAuthorizationRuntime,
) {
  const { buildSyntheticTextMessage, buildSyntheticContext, processMessageWithReplyChain } =
    messageRuntime;
  const {
    resolveTelegramEventAuthorizationContext,
    authorizeTelegramEventSender,
    isTelegramModelCallbackAuthorized,
  } = authorizationRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback || shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery = async () => {
      // Callback answers prevent Telegram retries while the routed action runs.
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => bot.api.answerCallbackQuery(callback.id),
      }).catch(() => {});
    };
    const earlyAnswerPromise = getTelegramCallbackQueryAnswerPromise(ctx);
    if (earlyAnswerPromise) {
      await earlyAnswerPromise.catch(answerCallbackQuery);
    } else {
      await answerCallbackQuery();
    }

    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(data);
      const genericCallbackText = data.startsWith("/") ? data : `callback_data: ${data}`;
      const callbackCommandText =
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : genericCallbackText);
      const hasReservedApprovalPrefix = hasTelegramApprovalCallbackPrefix(data);
      const typedApprovalCallback = parseTelegramApprovalCallbackData(data);
      const legacyApprovalCallback = parseExecApprovalCommandText(
        nativeCallbackCommand ?? (opaqueCallbackData ? "" : data),
      );
      const isApprovalCallback = hasReservedApprovalPrefix || legacyApprovalCallback !== null;
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: authorizationCfg,
        accountId,
      });
      // Approval controls retain their kind-specific authorization after capability changes.
      if (!isApprovalCallback) {
        if (
          inlineButtonsScope === "off" ||
          (inlineButtonsScope === "dm" && isGroup) ||
          (inlineButtonsScope === "group" && !isGroup)
        ) {
          return;
        }
      }

      const messageThreadId = callbackMessage.message_thread_id;
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
        isForum,
        senderId,
        messageThreadId,
      });
      const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = (groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`,
        );
        return;
      }
      const authorizationMode: TelegramEventAuthorizationMode =
        !isGroup || (!isApprovalCallback && inlineButtonsScope === "allowlist")
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

      const callbackThreadId = resolvedThreadId ?? dmThreadId;
      const callbackConversationId =
        callbackThreadId != null ? `${chatId}:topic:${callbackThreadId}` : String(chatId);
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const actions = createTelegramCallbackMessageActions({
        bot,
        callbackMessage,
        isGroup,
        isForum,
      });
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
      if (hasReservedApprovalPrefix) {
        await approvalRuntime.handleMalformedReserved();
        return;
      }
      if (
        await handleTelegramInteractiveCallback({
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
        })
      ) {
        return;
      }
      if (legacyApprovalCallback) {
        await approvalRuntime.handleLegacy(legacyApprovalCallback);
        return;
      }
      if (opaqueCallbackData) {
        return;
      }
      if (
        await handleTelegramModelCallback({
          data,
          ctx,
          chatId,
          isGroup,
          isForum,
          messageThreadId,
          resolvedThreadId,
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
    }
  });
}
