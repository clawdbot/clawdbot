import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applySessionModelSelection } from "openclaw/plugin-sdk/model-session-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  hasTelegramApprovalCallbackPrefix,
  parseTelegramApprovalCallbackData,
} from "./approval-callback-data.js";
import { resolveAgentDir, resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import {
  createTelegramCallbackMessageActions,
  handleTelegramQuestionCallback,
  type TelegramCallbackMessageActions,
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
import { getTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
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
      const opaqueCallbackData = parseTelegramOpaqueCallbackData(data);
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
        senderId,
        threadSpec: resolveTelegramMessageThreadSpec(callbackMessage, isForum),
      });
      const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
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
        isForum,
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

      const callbackThreadId = resolvedThreadId ?? dmThreadId;
      const callbackConversationId =
        callbackThreadId != null ? `${chatId}:topic:${callbackThreadId}` : String(chatId);
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

async function handleTelegramModelCallback(params: {
  data: string;
  ctx: Pick<TelegramContext, "me">;
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  messageThreadId?: number;
  resolvedThreadId?: number;
  senderId: string;
  runtimeCfg: OpenClawConfig;
  telegramDeps: RegisterTelegramHandlerParams["telegramDeps"];
  actions: TelegramCallbackMessageActions;
  messageRuntime: TelegramCallbackMessageRuntime;
  authorizeCallback: () => Promise<boolean>;
}): Promise<boolean> {
  const {
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
  } = params;
  const { editCallbackMessage, editCallbackMessageWithButtons: editMessageWithButtons } = actions;
  const retryModelAction = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw new TelegramRetryableCallbackError(error);
    }
  };

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
        isForum,
        messageThreadId,
        resolvedThreadId,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
        senderId,
        runtimeCfg,
      }).agentId;
    const result = await retryModelAction(async () => {
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

  const { sessionState, modelData } = await retryModelAction(async () => {
    const session = messageRuntime.resolveTelegramSessionState({
      chatId,
      isGroup,
      isForum,
      messageThreadId,
      resolvedThreadId,
      botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
      senderId,
      runtimeCfg,
    });
    const providerData = await telegramDeps.buildModelsProviderData(runtimeCfg, session.agentId);
    return { sessionState: session, modelData: providerData };
  });
  const { byProvider, providers, modelNames, resolvedDefault: activeResolvedDefault } = modelData;
  const providerInfos: ProviderInfo[] = providers.map((provider) => ({
    id: provider,
    count: byProvider.get(provider)?.size ?? 0,
  }));

  if (modelCallback.type === "providers" || modelCallback.type === "back") {
    if (providers.length === 0) {
      await retryModelAction(() => editMessageWithButtons("No providers available.", []));
      return true;
    }
    await retryModelAction(() =>
      editMessageWithButtons(
        "Select a provider:",
        buildTelegramModelsMenuButtons({ providers: providerInfos }),
      ),
    );
    return true;
  }

  if (modelCallback.type === "list") {
    const { provider, page } = modelCallback;
    const modelSet = byProvider.get(provider);
    if (!modelSet || modelSet.size === 0) {
      await retryModelAction(() =>
        editMessageWithButtons(
          `Unknown provider: ${provider}\n\nSelect a provider:`,
          buildTelegramModelsMenuButtons({ providers: providerInfos }),
        ),
      );
      return true;
    }
    const models = [...modelSet].toSorted((left, right) => left.localeCompare(right));
    const pageSize = getModelsPageSize();
    const totalPages = calculateTotalPages(models.length, pageSize);
    const safePage = Math.max(1, Math.min(page, totalPages));
    const currentModel =
      sessionState.model || `${activeResolvedDefault.provider}/${activeResolvedDefault.model}`;
    const buttons = buildModelsKeyboard({
      provider,
      models,
      currentModel,
      currentPage: safePage,
      totalPages,
      pageSize,
      modelNames,
    });
    const text = formatModelsAvailableHeader({
      provider,
      total: models.length,
      cfg: runtimeCfg,
      agentDir: resolveAgentDir(runtimeCfg, sessionState.agentId),
      sessionEntry: sessionState.sessionEntry,
    });
    await retryModelAction(() => editMessageWithButtons(text, buttons));
    return true;
  }

  if (modelCallback.type !== "select") {
    return true;
  }
  const selection = resolveModelSelection({ callback: modelCallback, providers, byProvider });
  if (selection.kind !== "resolved") {
    await retryModelAction(() =>
      editMessageWithButtons(
        `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
        buildTelegramModelsMenuButtons({ providers: providerInfos }),
      ),
    );
    return true;
  }
  if (!byProvider.get(selection.provider)?.has(selection.model)) {
    await retryModelAction(() =>
      editMessageWithButtons(
        `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
        [],
      ),
    );
    return true;
  }

  try {
    const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
      agentId: sessionState.agentId,
    });
    const resolvedDefault = resolveDefaultModelForAgent({
      cfg: runtimeCfg,
      agentId: sessionState.agentId,
    });
    const isDefaultSelection =
      selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;
    const persistedSessionEntry =
      sessionState.sessionEntry ??
      telegramDeps.getSessionEntry?.({ storePath, sessionKey: sessionState.sessionKey }) ??
      getSessionEntry({ storePath, sessionKey: sessionState.sessionKey });
    const sessionEntryMissing = persistedSessionEntry === undefined;
    const sessionEntry = persistedSessionEntry ?? {
      sessionId: randomUUID(),
      updatedAt: Date.now(),
    };
    const previousAuthProfileId = sessionEntry.authProfileOverride?.trim();
    const sessionStore = { [sessionState.sessionKey]: sessionEntry };
    const modelCatalog = [...byProvider.entries()].flatMap(([provider, models]) =>
      [...models].map((model) => ({ provider, id: model, name: model })),
    );
    const currentModelRef = sessionState.model?.trim();
    const currentModelSeparator = currentModelRef?.indexOf("/") ?? -1;
    const currentProvider =
      currentModelRef && currentModelSeparator > 0
        ? currentModelRef.slice(0, currentModelSeparator)
        : resolvedDefault.provider;
    const currentModel =
      currentModelRef && currentModelSeparator > 0
        ? currentModelRef.slice(currentModelSeparator + 1)
        : resolvedDefault.model;
    const applied = await retryModelAction(() =>
      applySessionModelSelection({
        cfg: runtimeCfg,
        agentId: sessionState.agentId,
        sessionKey: sessionState.sessionKey,
        storePath,
        sessionEntry,
        sessionStore,
        allowCreate: sessionEntryMissing,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
        currentProvider,
        currentModel,
        allowedModelKeys: new Set(modelCatalog.map((entry) => `${entry.provider}/${entry.id}`)),
        modelCatalog,
        canPersistStickyModelSelection: false,
        request: {
          provider: selection.provider,
          model: selection.model,
          isDefault: isDefaultSelection,
          runtime: { kind: "unchanged" },
        },
        markLiveSwitchPending: true,
      }),
    );
    if (applied.status !== "applied") {
      await editMessageWithButtons(`❌ ${applied.message}`, []);
      return true;
    }
    const defaultAuthProfileNotice =
      isDefaultSelection && previousAuthProfileId
        ? sessionStore[sessionState.sessionKey]?.authProfileOverride?.trim() ===
          previousAuthProfileId
          ? "Compatible auth profile retained."
          : "Incompatible auth profile cleared."
        : undefined;
    const escapeHtml = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const actionText = isDefaultSelection
      ? "reset to default"
      : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`;
    const runtimeText =
      applied.runtimeChange?.kind === "clear"
        ? "Runtime reset to configured policy."
        : "Runtime unchanged.";
    const scopeText = isDefaultSelection
      ? `Session model selection cleared.${defaultAuthProfileNotice ? ` ${defaultAuthProfileNotice}` : ""} ${runtimeText} New replies use the agent's configured default.`
      : `Session-only model selection. ${runtimeText} Use /model ${escapeHtml(selection.provider)}/${escapeHtml(selection.model)} --runtime &lt;runtime&gt; -s to switch harnesses. The agent default in openclaw.json is unchanged. This chat keeps the model selection across /new and /reset; use /model default -s to clear the session model selection.`;
    await editMessageWithButtons(`✅ Model ${actionText}\n\n${scopeText}`, [], {
      parse_mode: "HTML",
    });
  } catch (err) {
    if (err instanceof TelegramRetryableCallbackError) {
      throw err;
    }
    await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
  }
  return true;
}
