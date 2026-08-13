// Telegram plugin module implements native command registration behavior.
import type { Bot, Context } from "grammy";
import {
  findCommandByNativeName,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
} from "openclaw/plugin-sdk/command-auth-native";
import type {
  ChannelGroupPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createPluginCommandRuntime } from "openclaw/plugin-sdk/plugin-command-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type {
  TelegramNativeCommandCallbackDispatcher,
  TelegramResolvedGroupConfig,
} from "./bot-handlers.types.js";
import {
  defaultTelegramNativeCommandDeps,
  type TelegramNativeCommandDeps,
} from "./bot-native-command-deps.runtime.js";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands as syncTelegramMenuCommandsRuntime,
  type TelegramMenuCommand,
} from "./bot-native-command-menu.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "./command-config.js";

const loadTelegramBuiltinCommandExecutor = createLazyRuntimeModule(
  () => import("./bot-native-command-builtins.js"),
);
const loadTelegramPluginCommandExecutor = createLazyRuntimeModule(
  () => import("./bot-native-command-plugins.js"),
);

type TelegramNativeCommandContext = Context & { match?: string };

type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  mediaMaxBytes?: number;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => TelegramResolvedGroupConfig;
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  telegramDeps?: TelegramNativeCommandDeps;
  opts: Pick<
    TelegramBotOptions,
    | "token"
    | "ownerAgentId"
    | "botInfo"
    | "allowFrom"
    | "groupAllowFrom"
    | "replyToMode"
    | "accountAbortSignal"
  >;
};

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  mediaMaxBytes,
  nativeEnabled,
  nativeSkillsEnabled,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  telegramDeps = defaultTelegramNativeCommandDeps,
  opts,
}: RegisterTelegramNativeCommandsParams): TelegramNativeCommandCallbackDispatcher | undefined => {
  const boundRoute =
    nativeEnabled && nativeSkillsEnabled
      ? resolveAgentRoute({ cfg, channel: "telegram", accountId })
      : null;
  if (nativeEnabled && nativeSkillsEnabled && !boundRoute) {
    runtime.log?.(
      "nativeSkillsEnabled is true but no agent route is bound for this Telegram account; skill commands will not appear in the native menu.",
    );
  }
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled && boundRoute
      ? telegramDeps.listSkillCommandsForAgents({ cfg, agentIds: [boundRoute.agentId] })
      : [];
  const pluginCommandRuntime = createPluginCommandRuntime();
  const pluginCommandSpecs = pluginCommandRuntime.listNativeCandidates("telegram");
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "telegram" })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs({ provider: "telegram" }).map((command) =>
      normalizeTelegramCommandName(command.name),
    ),
  );
  for (const command of skillCommands) {
    reservedCommands.add(normalizeTelegramCommandName(command.name));
  }
  const customResolution = resolveTelegramCustomCommands({
    commands: telegramCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const pluginCatalog = buildPluginTelegramMenuCommands({
    specs: pluginCommandSpecs,
    existingCommands: new Set(reservedCommands),
  });
  for (const issue of pluginCatalog.issues) {
    runtime.error?.(danger(issue));
  }
  const firstSkillCommandIndex = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { provider: "telegram" }).length
    : 0;
  const nativeMenuCommands = nativeCommands
    .map((command, index): TelegramMenuCommand | null => {
      const normalized = normalizeTelegramCommandName(command.name);
      if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
        runtime.error?.(
          danger(
            `Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`,
          ),
        );
        return null;
      }
      return {
        command: normalized,
        description: command.description,
        ...(command.isAlias ? { isAlias: true } : {}),
        ...(index >= firstSkillCommandIndex ? { isSkill: true } : {}),
        ...(command.descriptionLocalizations
          ? { descriptionLocalizations: command.descriptionLocalizations }
          : {}),
      };
    })
    .filter((command) => command !== null);
  const customCommandNames = new Set(customCommands.map((command) => command.command));
  const fullCommandCatalog = buildCappedTelegramMenuCommands({
    allCommands: [
      ...customCommands,
      ...nativeMenuCommands.filter((command) => !command.isAlias),
      ...(nativeEnabled
        ? pluginCatalog.commands.filter((command) => !customCommandNames.has(command.command))
        : []),
      ...nativeMenuCommands.filter((command) => command.isAlias),
    ],
  });
  if (fullCommandCatalog.skillCommandsOmitted) {
    runtime.log?.(
      "Telegram menu pressure omitted per-skill commands; removing per-skill commands and keeping /skill.",
    );
  }
  const loginCommand = listNativeCommandSpecsForConfig(cfg, { provider: "telegram" }).find(
    (command) => findCommandByNativeName(command.name, "telegram")?.key === "login",
  );
  const nativeCommandsToHandle = nativeEnabled
    ? nativeCommands
    : loginCommand
      ? [loginCommand]
      : [];
  const {
    commandsToRegister,
    totalCommands,
    maxCommands,
    overflowCount,
    maxTotalChars,
    descriptionTrimmed,
    textBudgetDropCount,
  } = fullCommandCatalog;
  if (overflowCount > 0) {
    runtime.log?.(
      `Telegram limits bots to ${maxCommands} commands. ` +
        `${totalCommands} configured; registering first ${maxCommands}. ` +
        `Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`,
    );
  }
  if (descriptionTrimmed) {
    runtime.log?.(
      `Telegram menu text exceeded the conservative ${maxTotalChars}-character payload budget; shortening descriptions to keep ${commandsToRegister.length} commands visible.`,
    );
  }
  if (textBudgetDropCount > 0) {
    runtime.log?.(
      `Telegram menu text still exceeded the conservative ${maxTotalChars}-character payload budget after shortening descriptions; registering first ${commandsToRegister.length} commands.`,
    );
  }
  const syncTelegramMenuCommands =
    telegramDeps.syncTelegramMenuCommands ?? syncTelegramMenuCommandsRuntime;
  // Telegram only limits menu entries; hidden commands remain callable.
  syncTelegramMenuCommands({
    bot,
    runtime,
    commandsToRegister,
    accountId,
    botId: opts.botInfo?.id,
    botToken: opts.token,
  });

  const buildExecutorParams = (params: {
    botUser: Context["me"];
    msg: NonNullable<Context["message"]>;
    rawText: string;
  }) => ({
    ...params,
    bot,
    runtime,
    accountId,
    mediaMaxBytes,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    telegramDeps,
    opts,
  });
  let handleLoginCallback:
    | ((
        botUser: Context["me"],
        msg: NonNullable<Context["message"]>,
        rawText: string,
      ) => Promise<boolean>)
    | undefined;
  for (const command of nativeCommandsToHandle) {
    const normalizedCommandName = normalizeTelegramCommandName(command.name);
    const handleNativeCommand = async (
      botUser: Context["me"],
      msg: NonNullable<Context["message"]>,
      rawText: string,
    ): Promise<boolean> => {
      const { executeTelegramBuiltinCommand } = await loadTelegramBuiltinCommandExecutor();
      return await executeTelegramBuiltinCommand({
        ...buildExecutorParams({ botUser, msg, rawText }),
        commandName: command.name,
      });
    };
    if (nativeEnabled) {
      bot.command(normalizedCommandName, async (ctx) => {
        if (shouldSkipUpdate(ctx) || !ctx.message) {
          return;
        }
        await handleNativeCommand(
          ctx.me,
          ctx.message,
          typeof ctx.match === "string" ? ctx.match.trim() : "",
        );
      });
    }
    if (findCommandByNativeName(command.name, "telegram")?.key === "login") {
      handleLoginCallback = handleNativeCommand;
    }
  }

  for (const pluginCommand of pluginCatalog.selectedCommands) {
    bot.command(pluginCommand.command, async (ctx: TelegramNativeCommandContext) => {
      if (shouldSkipUpdate(ctx) || !ctx.message) {
        return;
      }
      const { executeTelegramPluginCommand } = await loadTelegramPluginCommandExecutor();
      await executeTelegramPluginCommand({
        ...buildExecutorParams({
          botUser: ctx.me,
          msg: ctx.message,
          rawText: ctx.match?.trim() ?? "",
        }),
        commandName: pluginCommand.command,
        candidate: pluginCommand.spec,
      });
    });
  }
  if (pluginCatalog.selectedCommands.length > 0) {
    pluginCommandRuntime.retainNativeCatalog("telegram");
  }

  if (!handleLoginCallback) {
    return undefined;
  }
  return async ({ botUser, callbackQuery, commandText }) => {
    const commandBody = commandText.slice(1).trim();
    const separatorIndex = commandBody.search(/\s/u);
    const commandName = (separatorIndex === -1 ? commandBody : commandBody.slice(0, separatorIndex))
      .split("@", 1)[0]
      ?.toLowerCase();
    const commandDefinition = commandName
      ? findCommandByNativeName(commandName, "telegram")
      : undefined;
    if (commandDefinition?.key !== "login") {
      return { handled: false, clearButtons: false };
    }
    const callbackMessage = callbackQuery.message;
    if (!callbackMessage || callbackMessage.date <= 0) {
      return { handled: true, clearButtons: false };
    }
    if (callbackMessage.chat.type === "channel") {
      return { handled: true, clearButtons: false };
    }
    const rawText = separatorIndex === -1 ? "" : commandBody.slice(separatorIndex + 1).trim();
    const clearButtons = await handleLoginCallback(
      botUser,
      {
        ...callbackMessage,
        chat: callbackMessage.chat,
        from: callbackQuery.from,
        text: commandText,
      },
      rawText,
    );
    return { handled: true, clearButtons };
  };
};
