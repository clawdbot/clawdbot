import { randomUUID } from "node:crypto";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyModelOverrideToSessionEntry,
  ModelSelectionLockedError,
} from "openclaw/plugin-sdk/model-session-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveDefaultModelForAgent,
} from "./bot-handlers.agent.runtime.js";
import type { TelegramCallbackMessageActions } from "./bot-handlers.callback-actions.runtime.js";
import { TelegramRetryableCallbackError } from "./bot-handlers.callback-errors.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { resolveTelegramBotHasTopicsEnabled } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";

export async function handleTelegramModelCallback(params: {
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
  messageRuntime: TelegramHandlerMessageRuntime;
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
  const { editCallbackMessage, deleteCallbackMessage, replyToCallbackChat } = actions;

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
    const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(runtimeCfg);
    let result: ReturnType<typeof buildCommandsMessagePaginated>;
    try {
      const skillCommands = telegramDeps.listSkillCommandsForAgents({
        cfg: runtimeCfg,
        agentIds: [agentId],
      });
      result = buildCommandsMessagePaginated(runtimeCfg, skillCommands, {
        page,
        forcePaginatedList: true,
        surface: "telegram",
      });
    } catch (err) {
      throw new TelegramRetryableCallbackError(err);
    }
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

  let sessionState: ReturnType<TelegramHandlerMessageRuntime["resolveTelegramSessionState"]>;
  let modelData: Awaited<ReturnType<typeof telegramDeps.buildModelsProviderData>>;
  try {
    sessionState = messageRuntime.resolveTelegramSessionState({
      chatId,
      isGroup,
      isForum,
      messageThreadId,
      resolvedThreadId,
      botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
      senderId,
      runtimeCfg,
    });
    modelData = await telegramDeps.buildModelsProviderData(runtimeCfg, sessionState.agentId);
  } catch (err) {
    throw new TelegramRetryableCallbackError(err);
  }
  const { byProvider, providers, modelNames, resolvedDefault: activeResolvedDefault } = modelData;

  const editMessageWithButtons = async (
    text: string,
    buttons: ReturnType<typeof buildProviderKeyboard>,
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

  if (modelCallback.type === "providers" || modelCallback.type === "back") {
    if (providers.length === 0) {
      try {
        await editMessageWithButtons("No providers available.", []);
      } catch (err) {
        throw new TelegramRetryableCallbackError(err);
      }
      return true;
    }
    const providerInfos: ProviderInfo[] = providers.map((provider) => ({
      id: provider,
      count: byProvider.get(provider)?.size ?? 0,
    }));
    try {
      await editMessageWithButtons(
        "Select a provider:",
        buildTelegramModelsMenuButtons({ providers: providerInfos }),
      );
    } catch (err) {
      throw new TelegramRetryableCallbackError(err);
    }
    return true;
  }

  if (modelCallback.type === "list") {
    const { provider, page } = modelCallback;
    const modelSet = byProvider.get(provider);
    if (!modelSet || modelSet.size === 0) {
      const providerInfos: ProviderInfo[] = providers.map((providerId) => ({
        id: providerId,
        count: byProvider.get(providerId)?.size ?? 0,
      }));
      try {
        await editMessageWithButtons(
          `Unknown provider: ${provider}\n\nSelect a provider:`,
          buildTelegramModelsMenuButtons({ providers: providerInfos }),
        );
      } catch (err) {
        throw new TelegramRetryableCallbackError(err);
      }
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
    try {
      await editMessageWithButtons(text, buttons);
    } catch (err) {
      throw new TelegramRetryableCallbackError(err);
    }
    return true;
  }

  if (modelCallback.type !== "select") {
    return true;
  }
  const selection = resolveModelSelection({ callback: modelCallback, providers, byProvider });
  if (selection.kind !== "resolved") {
    const providerInfos: ProviderInfo[] = providers.map((provider) => ({
      id: provider,
      count: byProvider.get(provider)?.size ?? 0,
    }));
    try {
      await editMessageWithButtons(
        `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
        buildTelegramModelsMenuButtons({ providers: providerInfos }),
      );
    } catch (err) {
      throw new TelegramRetryableCallbackError(err);
    }
    return true;
  }
  if (!byProvider.get(selection.provider)?.has(selection.model)) {
    try {
      await editMessageWithButtons(
        `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
        [],
      );
    } catch (err) {
      throw new TelegramRetryableCallbackError(err);
    }
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
    try {
      await patchSessionEntry({
        storePath,
        sessionKey: sessionState.sessionKey,
        fallbackEntry: { sessionId: randomUUID(), updatedAt: Date.now() },
        replaceEntry: true,
        update: (entry) => {
          applyModelOverrideToSessionEntry({
            entry,
            selection: {
              provider: selection.provider,
              model: selection.model,
              isDefault: isDefaultSelection,
            },
          });
          return entry;
        },
      });
    } catch (err) {
      if (err instanceof ModelSelectionLockedError) {
        try {
          await editMessageWithButtons(`❌ ${err.message}`, []);
        } catch (editErr) {
          throw new TelegramRetryableCallbackError(editErr);
        }
        return true;
      }
      throw new TelegramRetryableCallbackError(err);
    }
    const escapeHtml = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const actionText = isDefaultSelection
      ? "reset to default"
      : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`;
    const scopeText = isDefaultSelection
      ? "Session selection cleared. Runtime unchanged. New replies use the agent's configured default."
      : `Session-only model selection. Runtime unchanged. Use /model ${escapeHtml(selection.provider)}/${escapeHtml(selection.model)} --runtime &lt;runtime&gt; to switch harnesses. The agent default in openclaw.json is unchanged; /reset or a new session may return to that default.`;
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
