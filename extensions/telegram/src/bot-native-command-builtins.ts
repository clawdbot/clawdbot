// Telegram plugin module implements built-in native command behavior.
import {
  loadPreparedModelCatalog,
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultModelForAgent,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  formatFastModeCurrentStatus,
  parseCommandArgs,
  resolveCommandArgMenu,
  resolveEffectiveAgentRuntime,
  resolveFastModeState,
  resolveStoredModelOverride,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  getSessionEntry,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  dispatchTelegramBuiltinTurn,
  prepareTelegramCommandDispatch,
  type TelegramCommandExecutorParams,
} from "./bot-native-command-dispatch.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { buildTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

const loadTelegramLoginCommandExecutor = createLazyRuntimeModule(
  () => import("./bot-native-command-login.js"),
);

type TelegramCommandMenuModelContext = {
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  fastMode?: SessionEntry["fastMode"];
};

function buildTelegramCommandMenuModelContext(params: {
  provider: string;
  model: string;
  thinkingLevel?: string;
  fastMode?: SessionEntry["fastMode"];
}): TelegramCommandMenuModelContext {
  return {
    provider: params.provider,
    model: params.model,
    ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
  };
}

function resolveTelegramCommandMenuModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): TelegramCommandMenuModelContext {
  if (!params.sessionKey.trim()) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
    const entry = getSessionEntry({ storePath, sessionKey: params.sessionKey });
    const thinkingLevel = normalizeOptionalString(entry?.thinkingLevel);
    const fastMode = entry?.fastMode;
    let context: TelegramCommandMenuModelContext;
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      context = buildTelegramCommandMenuModelContext({
        provider: defaultModel.provider,
        model: defaultModel.model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(fastMode !== undefined ? { fastMode } : {}),
      });
    } else {
      const override = resolveStoredModelOverride({
        config: params.cfg,
        agentId: params.agentId,
        sessionEntry: entry,
        loadSessionEntry: (sessionKey) => getSessionEntry({ storePath, sessionKey }),
        sessionKey: params.sessionKey,
        defaultProvider: defaultModel.provider,
      });
      if (override?.model) {
        context = buildTelegramCommandMenuModelContext({
          provider: override.provider || defaultModel.provider,
          model: override.model,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(fastMode !== undefined ? { fastMode } : {}),
        });
      } else {
        const provider =
          normalizeOptionalString(entry?.providerOverride) ??
          normalizeOptionalString(entry?.modelProvider);
        const model =
          normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
        context = {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(fastMode !== undefined ? { fastMode } : {}),
        };
      }
    }
    return {
      ...context,
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: context.provider ?? defaultModel.provider,
        modelId: context.model ?? defaultModel.model,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: entry,
      }),
    };
  } catch {
    return {};
  }
}

function resolveTelegramFastCommandModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): { provider?: string; model?: string } {
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const fallback = () => ({ provider: defaultModel.provider, model: defaultModel.model });
  if (!params.sessionKey.trim()) {
    return fallback();
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({ storePath, sessionKey: params.sessionKey });
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      return fallback();
    }
    const override = resolveStoredModelOverride({
      config: params.cfg,
      agentId: params.agentId,
      sessionEntry: entry,
      loadSessionEntry: (sessionKey) => getSessionEntry({ storePath, sessionKey }),
      sessionKey: params.sessionKey,
      defaultProvider: defaultModel.provider,
    });
    return {
      provider: override?.provider ?? defaultModel.provider,
      model: override?.model ?? defaultModel.model,
    };
  } catch {
    return fallback();
  }
}

function resolveTelegramFastCommandState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const fallback = () =>
    resolveFastModeState({
      cfg: params.cfg,
      provider: defaultModel.provider,
      model: defaultModel.model,
      agentId: params.agentId,
    });
  if (!params.sessionKey.trim()) {
    return fallback();
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({ storePath, sessionKey: params.sessionKey });
    const modelContext = resolveTelegramFastCommandModelContext(params);
    return resolveFastModeState({
      cfg: params.cfg,
      provider: modelContext.provider ?? defaultModel.provider,
      model: modelContext.model ?? defaultModel.model,
      agentId: params.agentId,
      sessionEntry:
        entry?.fastMode !== undefined
          ? {
              fastMode: entry.fastMode,
            }
          : undefined,
    });
  } catch {
    return fallback();
  }
}

async function resolveTelegramThinkMenuCurrentLevel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  catalog: Awaited<ReturnType<typeof loadPreparedModelCatalog>>;
}): Promise<string> {
  const explicit = normalizeOptionalString(params.thinkingLevel);
  if (explicit) {
    return explicit;
  }
  const agentThinkingDefault = normalizeOptionalString(
    resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault,
  );
  if (agentThinkingDefault) {
    return agentThinkingDefault;
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  return await resolveThinkingDefaultWithRuntimeCatalog({
    cfg: params.cfg,
    provider: params.provider ?? defaultModel.provider,
    model: params.model ?? defaultModel.model,
    agentRuntime: params.agentRuntime,
    loadRuntimeCatalog: async () => params.catalog,
  });
}

function formatTelegramCommandArgMenuTitle(params: {
  command: NonNullable<ReturnType<typeof findCommandByNativeName>>;
  menu: NonNullable<ReturnType<typeof resolveCommandArgMenu>>;
  currentThinkingLevel?: string;
  currentFastModeStatus?: string;
}): string {
  const title = formatCommandArgMenuTitle({ command: params.command, menu: params.menu });
  if (params.command.key === "think" && params.currentThinkingLevel) {
    return `Current thinking level: ${params.currentThinkingLevel}.\n${title}`;
  }
  if (params.command.key === "fast" && params.currentFastModeStatus) {
    const options = params.menu.choices
      .map((choice) => choice.label.trim())
      .filter(Boolean)
      .join(", ");
    return options
      ? `${params.currentFastModeStatus}\nOptions: ${options}.`
      : params.currentFastModeStatus;
  }
  return title;
}

export async function executeTelegramBuiltinCommand(
  params: TelegramCommandExecutorParams & { commandName: string },
): Promise<boolean> {
  const dispatch = await prepareTelegramCommandDispatch({ ...params, requireAuth: true });
  if (!dispatch) {
    return false;
  }
  // Loaded-registry lookup only: Telegram defines no resolveNativeCommandName
  // hook, and the bundled fallback would jiti-load the plugin source in dev/test.
  const commandDefinition = findCommandByNativeName(params.commandName, "telegram", {
    includeBundledChannelFallback: false,
  });
  const commandArgs = commandDefinition
    ? parseCommandArgs(commandDefinition, params.rawText)
    : params.rawText
      ? ({ raw: params.rawText } satisfies CommandArgs)
      : undefined;
  const prompt = commandDefinition
    ? buildCommandTextFromArgs(commandDefinition, commandArgs)
    : params.rawText
      ? `/${params.commandName} ${params.rawText}`
      : `/${params.commandName}`;
  if (commandDefinition?.key === "login") {
    const { executeTelegramLoginCommand } = await loadTelegramLoginCommandExecutor();
    return await executeTelegramLoginCommand({ dispatch, commandArgs });
  }

  const menuNeedsModelContext =
    commandDefinition?.argsMenu &&
    !(commandArgs?.raw && !commandArgs.values) &&
    commandDefinition.args?.some(
      (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
    );
  const sessionKeyForMenu =
    commandDefinition && menuNeedsModelContext ? dispatch.targetSessionKey : "";
  const fastCommandState =
    commandDefinition?.key === "fast" && menuNeedsModelContext
      ? resolveTelegramFastCommandState({
          cfg: dispatch.runtimeCfg,
          agentId: dispatch.route.agentId,
          sessionKey: sessionKeyForMenu,
        })
      : undefined;
  const fastMenuModelContext =
    commandDefinition?.key === "fast" && menuNeedsModelContext
      ? resolveTelegramFastCommandModelContext({
          cfg: dispatch.runtimeCfg,
          agentId: dispatch.route.agentId,
          sessionKey: sessionKeyForMenu,
        })
      : undefined;
  const menuModelContext =
    commandDefinition && menuNeedsModelContext
      ? (fastMenuModelContext ??
        resolveTelegramCommandMenuModelContext({
          cfg: dispatch.runtimeCfg,
          agentId: dispatch.route.agentId,
          sessionKey: sessionKeyForMenu,
        }))
      : {};
  // Native /think must not wait on provider discovery; persisted rows retain its metadata.
  const menuModelCatalog =
    commandDefinition?.key === "think" && menuNeedsModelContext
      ? await loadPreparedModelCatalog({
          config: dispatch.runtimeCfg,
          agentId: dispatch.route.agentId,
          agentDir: resolveAgentDir(dispatch.runtimeCfg, dispatch.route.agentId),
          readOnly: true,
        })
      : undefined;
  const menu = commandDefinition
    ? resolveCommandArgMenu({
        command: commandDefinition,
        args: commandArgs,
        cfg: dispatch.runtimeCfg,
        ...menuModelContext,
        ...(menuModelCatalog?.length ? { catalog: menuModelCatalog } : {}),
      })
    : null;
  if (menu && commandDefinition) {
    const title = formatTelegramCommandArgMenuTitle({
      command: commandDefinition,
      menu,
      currentThinkingLevel:
        commandDefinition.key === "think"
          ? await resolveTelegramThinkMenuCurrentLevel({
              cfg: dispatch.runtimeCfg,
              agentId: dispatch.route.agentId,
              ...menuModelContext,
              catalog: menuModelCatalog ?? [],
            })
          : undefined,
      currentFastModeStatus:
        commandDefinition.key === "fast"
          ? formatFastModeCurrentStatus({
              ...(fastCommandState ??
                resolveTelegramFastCommandState({
                  cfg: dispatch.runtimeCfg,
                  agentId: dispatch.route.agentId,
                  sessionKey: sessionKeyForMenu,
                })),
            })
          : undefined,
    });
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let index = 0; index < menu.choices.length; index += 2) {
      rows.push(
        menu.choices.slice(index, index + 2).map((choice) => ({
          text: choice.label,
          callback_data: buildTelegramNativeCommandCallbackData(
            buildCommandTextFromArgs(commandDefinition, {
              values: { [menu.arg.name]: choice.value },
            }),
          ),
        })),
      );
    }
    const replyMarkup = buildInlineKeyboard(rows);
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () =>
        dispatch.bot.api.sendMessage(dispatch.chatId, title, {
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...dispatch.threadParams,
        }),
    });
    return false;
  }
  return await dispatchTelegramBuiltinTurn({ dispatch, prompt, commandArgs });
}
