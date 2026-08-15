import { randomUUID } from "node:crypto";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applySessionModelSelection } from "openclaw/plugin-sdk/model-session-runtime";
import { formatModelsAvailableHeader } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveAgentDir, resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import type { TelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";
import {
  type TelegramCallbackMessageRuntime,
  TelegramRetryableCallbackError,
} from "./bot-handlers.callback-router-controls.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { resolveTelegramBotHasTopicsEnabled, type TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { buildCommandsPaginationKeyboard, buildTelegramModelsMenuButtons } from "./command-ui.js";
import {
  buildModelsKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildModelSelectionConfirmation } from "./model-confirmation-message.js";
import { buildInlineKeyboard } from "./send.js";

export async function handleTelegramModelCallback(params: {
  data: string;
  ctx: Pick<TelegramContext, "me">;
  chatId: number;
  isGroup: boolean;
  threadSpec: TelegramThreadSpec;
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
    threadSpec,
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
        threadSpec,
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
      threadSpec,
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
    // The picker's provider/model-list steps stay on the legacy HTML funnel (no
    // richTextOverride supplied). This final confirmation edits the same rich-sent
    // message, so it must explicitly opt into the rich funnel via richTextOverride --
    // a legacy-HTML edit here would leave the prior rich body's markup visible
    // underneath the new text instead of replacing it (issue #123886).
    const confirmation = buildModelSelectionConfirmation({
      isDefaultSelection,
      provider: selection.provider,
      model: selection.model,
      runtimeReset: applied.runtimeChange?.kind === "clear",
      defaultAuthProfileNotice,
    });
    await editMessageWithButtons(
      confirmation.html,
      [],
      { parse_mode: "HTML" },
      { blocks: confirmation.richBlocks },
    );
  } catch (err) {
    if (err instanceof TelegramRetryableCallbackError) {
      throw err;
    }
    await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
  }
  return true;
}
