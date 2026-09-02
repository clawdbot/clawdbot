import type { Context } from "grammy";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import { resolveAgentDir } from "./bot-handlers.agent.runtime.js";
import {
  createTelegramCallbackMessageActions,
  handleTelegramQuestionCallback,
  sendTelegramQuestionFeedback,
  type TelegramCallbackMessageActions,
} from "./bot-handlers.callback-actions.js";
import { applyTelegramModelCallbackSelection } from "./bot-handlers.callback-model-selection.js";
import * as modelSupport from "./bot-handlers.callback-model.js";
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
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMessageThreadSpec,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import {
  getTelegramCallbackQueryAnswerPromise,
  startTelegramCallbackQueryAnswer,
} from "./callback-query-answer-state.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  calculateTotalPages,
  parseModelCallbackData,
  resolveModelListCallback,
  resolveModelSelection,
} from "./model-buttons.js";
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
import { buildInlineKeyboard } from "./send.js";
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
    resolveTelegramModelCallbackAuthorization,
    reauthorizeTelegramModelCallback,
  } = authorizationRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);

  const handleCallback = async (ctx: Context) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    let callbackAnswered = false;
    const answerCallbackQuery = async () => {
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => startTelegramCallbackQueryAnswer(bot, callback.id, false),
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
      const hasReservedModelPrefix = data.startsWith("mdl1~");
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
      const isShortModelCallback =
        nativeCallbackCommand !== null && /^\/model(?:\s|$)/iu.test(nativeCallbackCommand.trim());
      const isModelCallback = hasReservedModelPrefix || isShortModelCallback;
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
        !hasReservedOpaquePrefix &&
        !hasReservedModelPrefix
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
        ((nativeCallbackCommand && !legacyApprovalCallback) ||
          hasReservedOpaquePrefix ||
          hasReservedModelPrefix)
      ) {
        await terminalizeUnavailableCallback();
        return;
      }
      if (nativeCallbackCommand && nativeCommandCallbackDispatcher && !isShortModelCallback) {
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
      // Model controls own their command-owner admission below. Running the generic
      // DM allowlist first would deny command owners under pairing policy.
      const authorizationMode: TelegramEventAuthorizationMode = hasReservedQuestionPrefix
        ? "callback-runtime-allowlist"
        : isModelCallback
          ? "callback-scope"
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
      const modelAuthParams = { chatId, isGroup, senderId, senderUsername };
      let modelCallbackAuthorization:
        | ReturnType<TelegramHandlerAuthorization["resolveTelegramModelCallbackAuthorization"]>
        | undefined;
      const resolveModelCallbackAuthorization = () =>
        (modelCallbackAuthorization ??= resolveTelegramModelCallbackAuthorization({
          ...modelAuthParams,
          context: eventAuthContext,
        }));
      const authorizeCallback = async () => (await resolveModelCallbackAuthorization()).authorized;
      if (isShortModelCallback && !(await authorizeCallback())) {
        return;
      }
      if (typedApprovalCallback) {
        await approvalRuntime.handleCanonical(typedApprovalCallback);
        return;
      }
      if (typedQuestionCallback) {
        await handleTelegramQuestionCallback({
          callback: typedQuestionCallback,
          cfg: runtimeCfg,
          senderId,
          feedback: async (text, mode) =>
            await sendTelegramQuestionFeedback({
              actions,
              text,
              mode,
              isGroup,
              user: callback.from,
            }),
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
        !hasReservedModelPrefix &&
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
          reauthorizeCallback: () => reauthorizeTelegramModelCallback(modelAuthParams, threadSpec),
        })
      ) {
        return;
      }
      if (hasReservedModelPrefix) {
        await terminalizeUnavailableCallback();
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
          ...(isShortModelCallback ? { revalidateCommandOwnerAccess: true } : {}),
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

async function handleTelegramModelCallback(params: {
  data: string;
  ctx: Pick<TelegramContext, "me">;
  chatId: number;
  isGroup: boolean;
  threadSpec: ReturnType<typeof resolveTelegramMessageThreadSpec>;
  senderId: string;
  runtimeCfg: OpenClawConfig;
  telegramDeps: RegisterTelegramHandlerParams["telegramDeps"];
  actions: TelegramCallbackMessageActions;
  messageRuntime: TelegramCallbackMessageRuntime;
  authorizeCallback: () => Promise<boolean>;
  reauthorizeCallback: () => Promise<boolean>;
}): Promise<boolean> {
  const {
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
    reauthorizeCallback,
  } = params;
  const { editCallbackMessage, editCallbackMessageWithButtons: editMessageWithButtons } = actions;

  const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
  if (paginationMatch) {
    const pageValue = paginationMatch[1];
    if (pageValue === "noop") {
      return true;
    }
    const page = parseStrictPositiveInteger(pageValue);
    if (page === undefined) {
      return true;
    }
    const agentId =
      paginationMatch[2]?.trim() ||
      messageRuntime.resolveTelegramSessionState({
        chatId,
        isGroup,
        threadSpec,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
        senderId,
        runtimeCfg,
      }).agentId;
    const result = await modelSupport.retry(async () => {
      const skillCommands = telegramDeps.listSkillCommandsForAgents({
        cfg: runtimeCfg,
        agentIds: [agentId],
      });
      return buildCommandsMessagePaginated(runtimeCfg, skillCommands, {
        page,
        forcePaginatedList: true,
        surface: "telegram",
      });
    });
    const keyboard =
      result.totalPages > 1
        ? buildInlineKeyboard(
            buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
          )
        : undefined;
    try {
      await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : undefined);
    } catch (editErr) {
      if (!String(editErr).includes("message is not modified")) {
        throw new TelegramRetryableCallbackError(editErr);
      }
    }
    return true;
  }

  const modelCallback = parseModelCallbackData(data);
  if (!modelCallback) {
    return false;
  }
  if (!(await authorizeCallback())) {
    logVerbose(
      `Blocked telegram model callback from ${senderId || "unknown"} (not authorized for /models)`,
    );
    return true;
  }

  const { sessionState, modelData } = await modelSupport.retry(async () => {
    const session = messageRuntime.resolveTelegramSessionState({
      chatId,
      isGroup,
      threadSpec,
      botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
      senderId,
      runtimeCfg,
    });
    const providerData = await telegramDeps.buildModelsProviderData(runtimeCfg, session.agentId);
    return { sessionState: session, modelData: providerData };
  });
  const { byProvider, providers, modelNames, resolvedDefault: activeResolvedDefault } = modelData;
  const providerInfos = modelSupport.providerInfos(providers, byProvider);

  if (modelCallback.type === "providers" || modelCallback.type === "back") {
    if (providers.length === 0) {
      await modelSupport.retry(() => editMessageWithButtons("No providers available.", []));
      return true;
    }
    await modelSupport.retry(() =>
      editMessageWithButtons(
        "Select a provider:",
        buildTelegramModelsMenuButtons({ providers: providerInfos }),
      ),
    );
    return true;
  }

  if (modelCallback.type === "list" || modelCallback.type === "list-ref") {
    const listSelection = resolveModelListCallback({ callback: modelCallback, providers });
    if (!listSelection) {
      await modelSupport.retry(() =>
        editMessageWithButtons(
          "This model picker is stale or ambiguous. Reopen /model and try again.",
          buildTelegramModelsMenuButtons({ providers: providerInfos }),
        ),
      );
      return true;
    }
    const { provider, page } = listSelection;
    const modelSet = byProvider.get(provider);
    if (!modelSet || modelSet.size === 0) {
      await modelSupport.retry(() =>
        editMessageWithButtons(
          `Unknown provider: ${provider}\n\nSelect a provider:`,
          buildTelegramModelsMenuButtons({ providers: providerInfos }),
        ),
      );
      return true;
    }
    const models = [...modelSet].toSorted((left, right) => left.localeCompare(right));
    const totalPages = calculateTotalPages(models.length);
    const safePage = Math.max(1, Math.min(page, totalPages));
    const currentModel =
      sessionState.model || `${activeResolvedDefault.provider}/${activeResolvedDefault.model}`;
    const buttons = buildModelsKeyboard({
      provider,
      models,
      currentModel,
      currentPage: safePage,
      totalPages,
      modelNames,
    });
    const text = `${formatModelsAvailableHeader({
      provider,
      total: models.length,
      cfg: runtimeCfg,
      agentDir: resolveAgentDir(runtimeCfg, sessionState.agentId),
      sessionEntry: sessionState.sessionEntry,
    })}\nSelecting a model preserves a compatible session runtime.`;
    await modelSupport.retry(() => editMessageWithButtons(text, buttons));
    return true;
  }

  if (modelCallback.type !== "select" && modelCallback.type !== "select-ref") {
    return true;
  }
  const selection = resolveModelSelection({ callback: modelCallback, providers, byProvider });
  if (selection.kind !== "resolved") {
    await modelSupport.retry(() =>
      editMessageWithButtons(
        `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
        buildTelegramModelsMenuButtons({ providers: providerInfos }),
      ),
    );
    return true;
  }
  if (!byProvider.get(selection.provider)?.has(selection.model)) {
    await modelSupport.retry(() =>
      editMessageWithButtons(
        `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
        [],
      ),
    );
    return true;
  }

  await applyTelegramModelCallbackSelection({
    callback: modelCallback,
    expectedSelection: selection,
    chatId,
    isGroup,
    threadSpec,
    botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
    senderId,
    telegramDeps,
    messageRuntime,
    editMessageWithButtons,
    reauthorizeCallback,
  });
  return true;
}
