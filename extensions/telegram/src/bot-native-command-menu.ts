// Telegram plugin module implements bot native command menu behavior.
import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import type { LanguageCode } from "grammy/types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  enqueueTelegramMenuSync,
  getProcessKnownTelegramMenuLocales,
  normalizeTelegramMenuLanguageCode,
  persistTelegramMenuLocaleLedger,
  readTelegramMenuCommandHash,
  readTelegramMenuLocaleLedger,
  resolveTelegramMenuRemoteOwner,
  writeTelegramMenuCommandHash,
} from "./bot-native-command-menu-state.js";
import { normalizeTelegramCommandName, TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config.js";

const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET = 5700;
const TELEGRAM_COMMAND_RETRY_RATIO = 0.8;
const TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH = 1;
const TELEGRAM_MAX_COMMAND_DESCRIPTION_LENGTH = 256;
const TELEGRAM_MENU_RESULT_CACHE_MAX = 128;

export type TelegramMenuCommand = {
  command: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  isAlias?: boolean;
  isConfigured?: boolean;
  isSkill?: boolean;
};

type TelegramCommandMenuScope =
  | { label: "default"; options?: undefined }
  | { label: "all_group_chats"; options: { scope: { type: "all_group_chats" } } };

type TelegramPluginCommandSpec = {
  name: unknown;
  description: unknown;
  descriptionLocalizations?: Record<string, string>;
};

const TELEGRAM_COMMAND_MENU_SCOPES: readonly TelegramCommandMenuScope[] = [
  { label: "default" },
  { label: "all_group_chats", options: { scope: { type: "all_group_chats" } } },
];

const cappedTelegramMenuCache = new Map<
  string,
  ReturnType<typeof buildUncachedCappedTelegramMenuCommands>
>();

function countTelegramCommandText(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    index += codePoint && codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

function truncateTelegramCommandText(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  const suffix = maxLength > 1 ? "…" : "";
  const prefixLimit = maxLength - countTelegramCommandText(suffix);
  let count = 0;
  let prefixEnd = 0;
  for (const char of value) {
    count += 1;
    if (count <= prefixLimit) {
      prefixEnd += char.length;
    }
    if (count > maxLength) {
      return `${value.slice(0, prefixEnd)}${suffix}`;
    }
  }
  return value;
}

function fitTelegramCommandsWithinTextBudget(
  commands: TelegramMenuCommand[],
  maxTotalChars: number,
): {
  commands: TelegramMenuCommand[];
  descriptionTrimmed: boolean;
  textBudgetDropCount: number;
} {
  let candidateCommands = [...commands];
  while (candidateCommands.length > 0) {
    const commandNameChars = candidateCommands.reduce(
      (total, command) => total + countTelegramCommandText(command.command),
      0,
    );
    const descriptionBudget = maxTotalChars - commandNameChars;
    const minimumDescriptionBudget =
      candidateCommands.length * TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH;
    if (descriptionBudget < minimumDescriptionBudget) {
      candidateCommands = candidateCommands.slice(0, -1);
      continue;
    }

    const descriptionCap = Math.max(
      TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH,
      Math.floor(descriptionBudget / candidateCommands.length),
    );
    let descriptionTrimmed = false;
    const fittedCommands = candidateCommands.map((command) => {
      const description = truncateTelegramCommandText(
        command.description,
        Math.min(descriptionCap, TELEGRAM_MAX_COMMAND_DESCRIPTION_LENGTH),
      );
      if (description !== command.description) {
        descriptionTrimmed = true;
        return Object.assign({}, command, { description });
      }
      return command;
    });
    return {
      commands: fittedCommands,
      descriptionTrimmed,
      textBudgetDropCount: commands.length - fittedCommands.length,
    };
  }

  return {
    commands: [],
    descriptionTrimmed: false,
    textBudgetDropCount: commands.length,
  };
}

function readErrorTextField(value: unknown, key: "description" | "message"): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  return readStringValue((value as Record<"description" | "message", unknown>)[key]);
}

function isBotCommandsTooMuchError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const pattern = /\bBOT_COMMANDS_TOO_MUCH\b/i;
  if (typeof err === "string") {
    return pattern.test(err);
  }
  if (err instanceof Error) {
    if (pattern.test(err.message)) {
      return true;
    }
  }
  const description = readErrorTextField(err, "description");
  if (description && pattern.test(description)) {
    return true;
  }
  const message = readErrorTextField(err, "message");
  if (message && pattern.test(message)) {
    return true;
  }
  return false;
}

function formatTelegramCommandRetrySuccessLog(params: {
  initialCount: number;
  acceptedCount: number;
}): string {
  const omittedCount = Math.max(0, params.initialCount - params.acceptedCount);
  return (
    `Telegram accepted ${params.acceptedCount} commands after BOT_COMMANDS_TOO_MUCH ` +
    `(started with ${params.initialCount}; omitted ${omittedCount}). ` +
    "Reduce plugin/skill/custom commands to expose more menu entries."
  );
}

export function buildPluginTelegramMenuCommands(params: {
  specs: TelegramPluginCommandSpec[];
  existingCommands: Set<string>;
}): { commands: TelegramMenuCommand[]; issues: string[] } {
  const { specs, existingCommands } = params;
  const commands: TelegramMenuCommand[] = [];
  const issues: string[] = [];
  const pluginCommandNames = new Set<string>();

  for (const spec of specs) {
    const rawName = typeof spec.name === "string" ? spec.name : "";
    const normalized = normalizeTelegramCommandName(rawName);
    if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
      const invalidName = rawName.trim() ? rawName : "<unknown>";
      issues.push(
        `Plugin command "/${invalidName}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`,
      );
      continue;
    }
    const description = normalizeOptionalString(spec.description) ?? "";
    if (!description) {
      issues.push(`Plugin command "/${normalized}" is missing a description.`);
      continue;
    }
    if (existingCommands.has(normalized)) {
      if (pluginCommandNames.has(normalized)) {
        issues.push(`Plugin command "/${normalized}" is duplicated.`);
      } else {
        issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
      }
      continue;
    }
    pluginCommandNames.add(normalized);
    existingCommands.add(normalized);
    const menuCommand: TelegramMenuCommand = { command: normalized, description };
    if (spec.descriptionLocalizations) {
      menuCommand.descriptionLocalizations = spec.descriptionLocalizations;
    }
    commands.push(menuCommand);
  }

  return { commands, issues };
}

export function buildCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands?: number;
  maxTotalChars?: number;
}): ReturnType<typeof buildUncachedCappedTelegramMenuCommands> {
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const maxTotalChars = params.maxTotalChars ?? TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET;
  const cacheKey = buildTelegramMenuResultCacheKey({
    allCommands: params.allCommands,
    maxCommands,
    maxTotalChars,
  });
  const cached = cappedTelegramMenuCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const result = buildUncachedCappedTelegramMenuCommands({
    allCommands: params.allCommands,
    maxCommands,
    maxTotalChars,
  });
  rememberCappedTelegramMenuResult(cacheKey, result);
  return result;
}

export function orderForPressure(commands: TelegramMenuCommand[]): TelegramMenuCommand[] {
  return [
    ...commands.filter((command) => command.isConfigured),
    ...commands.filter((command) => !command.isConfigured && !command.isAlias),
    ...commands.filter((command) => !command.isConfigured && command.isAlias),
  ];
}

function buildUncachedCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands: number;
  maxTotalChars: number;
}): {
  commandsToRegister: TelegramMenuCommand[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
  maxTotalChars: number;
  descriptionTrimmed: boolean;
  textBudgetDropCount: number;
} {
  const { allCommands } = params;
  const { maxCommands, maxTotalChars } = params;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const cappedCommands = allCommands.slice(0, maxCommands);
  const totalText = cappedCommands.reduce(
    (total, { command, description }) =>
      total + countTelegramCommandText(command) + countTelegramCommandText(description),
    0,
  );
  const hasMenuPressure =
    overflowCount > 0 ||
    totalText > maxTotalChars ||
    cappedCommands.some(
      (command) =>
        countTelegramCommandText(command.description) > TELEGRAM_MAX_COMMAND_DESCRIPTION_LENGTH,
    );
  const fitted = hasMenuPressure
    ? fitTelegramCommandsWithinTextBudget(
        orderForPressure(allCommands).slice(0, maxCommands),
        maxTotalChars,
      )
    : { commands: cappedCommands, descriptionTrimmed: false, textBudgetDropCount: 0 };
  return {
    commandsToRegister: fitted.commands,
    totalCommands,
    maxCommands,
    overflowCount,
    maxTotalChars,
    descriptionTrimmed: fitted.descriptionTrimmed,
    textBudgetDropCount: fitted.textBudgetDropCount,
  };
}

function buildTelegramMenuResultCacheKey(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands: number;
  maxTotalChars: number;
}): string {
  const digest = createHash("sha256");
  updateTelegramCommandDigestField(digest, String(params.maxCommands));
  updateTelegramCommandDigestField(digest, String(params.maxTotalChars));
  for (const command of params.allCommands) {
    updateTelegramCommandDigestField(digest, command.command);
    updateTelegramCommandDigestField(digest, command.description);
    updateTelegramCommandDigestField(digest, command.isAlias ? "1" : "0");
    updateTelegramCommandDigestField(digest, command.isConfigured ? "1" : "0");
    updateTelegramCommandDigestField(digest, command.isSkill ? "1" : "0");
    updateTelegramCommandLocalizationDigest(digest, command.descriptionLocalizations);
  }
  return digest.digest("hex").slice(0, 16);
}

function updateTelegramCommandDigestField(
  digest: ReturnType<typeof createHash>,
  value: string,
): void {
  digest.update(String(value.length));
  digest.update(":");
  digest.update(value);
}

function updateTelegramCommandLocalizationDigest(
  digest: ReturnType<typeof createHash>,
  localizations: Record<string, string> | undefined,
): void {
  const entries = Object.entries(localizations ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  updateTelegramCommandDigestField(digest, String(entries.length));
  for (const [locale, description] of entries) {
    updateTelegramCommandDigestField(digest, locale);
    updateTelegramCommandDigestField(digest, description);
  }
}

function rememberCappedTelegramMenuResult(
  key: string,
  result: ReturnType<typeof buildUncachedCappedTelegramMenuCommands>,
): void {
  cappedTelegramMenuCache.set(key, result);
  if (cappedTelegramMenuCache.size <= TELEGRAM_MENU_RESULT_CACHE_MAX) {
    return;
  }
  const oldestKey = cappedTelegramMenuCache.keys().next().value;
  if (oldestKey) {
    cappedTelegramMenuCache.delete(oldestKey);
  }
}

function hashCommandList(commands: TelegramMenuCommand[]): string {
  const requestedCommands = commands.map((command) => ({
    command: command.command,
    description: command.description,
    descriptionLocalizations: command.descriptionLocalizations,
  }));
  return createHash("sha256").update(JSON.stringify(requestedCommands)).digest("hex").slice(0, 16);
}

function readLocalizedDescription(
  command: TelegramMenuCommand,
  languageCode: string,
): string | undefined {
  for (const [rawLanguageCode, rawDescription] of Object.entries(
    command.descriptionLocalizations ?? {},
  )) {
    if (normalizeTelegramMenuLanguageCode(rawLanguageCode) !== languageCode) {
      continue;
    }
    const description = normalizeOptionalString(rawDescription);
    if (description) {
      return description;
    }
  }
  return undefined;
}

function toTelegramBotCommands(commands: TelegramMenuCommand[]): Array<{
  command: string;
  description: string;
}> {
  return commands.map((command) => ({
    command: command.command,
    description: command.description,
  }));
}

function buildLocalizedCommandVariants(commands: TelegramMenuCommand[]): {
  variants: Array<{ languageCode: string; commands: TelegramMenuCommand[] }>;
  unsupportedLanguageCodes: string[];
} {
  const locales = new Set<string>();
  const unsupportedLanguageCodes = new Set<string>();
  for (const command of commands) {
    for (const rawLanguageCode of Object.keys(command.descriptionLocalizations ?? {})) {
      const normalized = normalizeTelegramMenuLanguageCode(rawLanguageCode);
      if (normalized) {
        locales.add(normalized);
      } else {
        unsupportedLanguageCodes.add(rawLanguageCode);
      }
    }
  }
  const variants = [...locales].toSorted().map((languageCode) => {
    const localizedCommands = commands.map((cmd) => ({
      ...cmd,
      description: readLocalizedDescription(cmd, languageCode) ?? cmd.description,
    }));
    return {
      languageCode,
      commands: buildCappedTelegramMenuCommands({
        allCommands: localizedCommands,
      }).commandsToRegister,
    };
  });
  return {
    variants,
    unsupportedLanguageCodes: [...unsupportedLanguageCodes].toSorted(),
  };
}

function formatTelegramCommandScopeOperation(
  operation: "deleteMyCommands" | "setMyCommands",
  scope: TelegramCommandMenuScope,
  languageCode?: string,
): string {
  const base = scope.label === "default" ? operation : `${operation}(${scope.label})`;
  return languageCode ? `${base}(${languageCode})` : base;
}

function buildTelegramCommandScopeOptions(
  scope: TelegramCommandMenuScope,
  languageCode?: string,
): { scope?: { type: "all_group_chats" }; language_code?: LanguageCode } | undefined {
  return scope.options || languageCode
    ? {
        ...scope.options,
        ...(languageCode ? { language_code: languageCode as LanguageCode } : {}),
      }
    : undefined;
}

async function clearTelegramMenuCommandsForScopes(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  languageCode?: string;
}): Promise<boolean> {
  const { bot, runtime, languageCode } = params;

  let allCleared = true;
  for (const scope of TELEGRAM_COMMAND_MENU_SCOPES) {
    const options = buildTelegramCommandScopeOptions(scope, languageCode);
    const operation =
      typeof bot.api.deleteMyCommands === "function" ? "deleteMyCommands" : "setMyCommands";
    const cleared = await withTelegramApiErrorLogging({
      operation: formatTelegramCommandScopeOperation(operation, scope, languageCode),
      runtime,
      fn: () => {
        if (typeof bot.api.deleteMyCommands === "function") {
          return options ? bot.api.deleteMyCommands(options) : bot.api.deleteMyCommands();
        }
        return options ? bot.api.setMyCommands([], options) : bot.api.setMyCommands([]);
      },
    })
      .then(() => true)
      .catch(() => false);
    allCleared &&= cleared;
  }
  return allCleared;
}

async function setTelegramMenuCommandsForScopes(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commands: TelegramMenuCommand[];
  languageCode?: string;
  shouldLog?: (err: unknown) => boolean;
}): Promise<void> {
  const { bot, runtime, commands, languageCode, shouldLog } = params;
  const botCommands = toTelegramBotCommands(commands);
  for (const scope of TELEGRAM_COMMAND_MENU_SCOPES) {
    await withTelegramApiErrorLogging({
      operation: formatTelegramCommandScopeOperation("setMyCommands", scope, languageCode),
      runtime,
      shouldLog,
      fn: () => {
        const opts = buildTelegramCommandScopeOptions(scope, languageCode);
        return opts ? bot.api.setMyCommands(botCommands, opts) : bot.api.setMyCommands(botCommands);
      },
    });
  }
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
  accountId?: string;
  botId?: number;
  botToken?: string;
}): void {
  const { bot, runtime, commandsToRegister } = params;
  const owner = resolveTelegramMenuRemoteOwner(params);
  const sync = async () => {
    // Skip sync if the command list hasn't changed since the last successful
    // sync. This prevents hitting Telegram's 429 rate limit when the gateway
    // is restarted several times in quick succession.
    // See: openclaw/openclaw#32017
    const currentHash = hashCommandList(commandsToRegister);
    const cachedHash = readTelegramMenuCommandHash(owner.hashKey);
    if (cachedHash === currentHash) {
      logVerbose("telegram: command menu unchanged; skipping sync");
      return;
    }

    const processLocales = getProcessKnownTelegramMenuLocales(owner.queueKey);
    const ledgerRead = owner.botId
      ? await readTelegramMenuLocaleLedger({ botId: owner.botId, runtime })
      : null;
    const trackedLocales = new Set([
      ...processLocales,
      ...(ledgerRead?.value?.languageCodes ?? []),
    ]);

    // Keep every exact scope/language clear ahead of publication.
    const neutralCleared = await clearTelegramMenuCommandsForScopes({ bot, runtime });
    const unclearedLocales = new Set<string>();
    for (const languageCode of [...trackedLocales].toSorted()) {
      const cleared = await clearTelegramMenuCommandsForScopes({
        bot,
        runtime,
        languageCode,
      });
      if (!cleared) {
        unclearedLocales.add(languageCode);
      }
    }
    processLocales.clear();
    for (const languageCode of unclearedLocales) {
      processLocales.add(languageCode);
    }

    const persistLocales = async (desiredLocales: string[]): Promise<boolean> => {
      const conservativeLocales = [...new Set([...unclearedLocales, ...desiredLocales])].toSorted();
      processLocales.clear();
      for (const languageCode of conservativeLocales) {
        processLocales.add(languageCode);
      }
      if (!owner.botId) {
        return true;
      }
      if (!ledgerRead) {
        return false;
      }
      try {
        await persistTelegramMenuLocaleLedger({
          botId: owner.botId,
          read: ledgerRead,
          languageCodes: conservativeLocales,
        });
        return true;
      } catch (error) {
        runtime.error?.(
          `Telegram command menu locale ledger write failed for bot ${owner.botId}: ${String(error)}`,
        );
        return false;
      }
    };

    if (commandsToRegister.length === 0) {
      const ledgerComplete = await persistLocales([]);
      if (neutralCleared && unclearedLocales.size === 0 && ledgerComplete) {
        writeTelegramMenuCommandHash(owner.hashKey, currentHash);
      } else {
        runtime.log?.(
          "telegram: command menu cleanup incomplete; skipping success hash cache write",
        );
      }
      return;
    }

    let retryCommands = commandsToRegister;
    let acceptedCommands: TelegramMenuCommand[] | null = null;
    const initialCommandCount = commandsToRegister.length;
    while (retryCommands.length > 0) {
      try {
        await setTelegramMenuCommandsForScopes({
          bot,
          runtime,
          commands: retryCommands,
          shouldLog: (err) => !isBotCommandsTooMuchError(err),
        });
        if (retryCommands.length < initialCommandCount) {
          runtime.log?.(
            formatTelegramCommandRetrySuccessLog({
              initialCount: initialCommandCount,
              acceptedCount: retryCommands.length,
            }),
          );
        }
        acceptedCommands = retryCommands;
        break;
      } catch (err) {
        if (!isBotCommandsTooMuchError(err)) {
          throw err;
        }
        const nextCount = Math.floor(retryCommands.length * TELEGRAM_COMMAND_RETRY_RATIO);
        const reducedCount =
          nextCount < retryCommands.length ? nextCount : retryCommands.length - 1;
        if (reducedCount <= 0) {
          runtime.error?.(
            "Telegram rejected native command registration (BOT_COMMANDS_TOO_MUCH); leaving menu empty. Reduce commands or disable channels.telegram.commands.native.",
          );
          return;
        }
        runtime.log?.(
          `Telegram rejected ${retryCommands.length} commands (BOT_COMMANDS_TOO_MUCH); retrying with ${reducedCount}.`,
        );
        retryCommands = orderForPressure(retryCommands).slice(0, reducedCount);
      }
    }

    if (!acceptedCommands) {
      return;
    }

    const { variants, unsupportedLanguageCodes } = buildLocalizedCommandVariants(acceptedCommands);
    if (unsupportedLanguageCodes.length > 0) {
      runtime.log?.(
        `Telegram command menu ignored unsupported description localization codes: ${unsupportedLanguageCodes.join(", ")}.`,
      );
    }

    const desiredLocales = variants.map((variant) => variant.languageCode);
    const ledgerComplete = await persistLocales(desiredLocales);
    if (!ledgerComplete) {
      runtime.log?.(
        "telegram: localized command menu skipped because locale intent was not durably recorded",
      );
      return;
    }

    for (const variant of variants) {
      await setTelegramMenuCommandsForScopes({
        bot,
        runtime,
        commands: variant.commands,
        languageCode: variant.languageCode,
      });
    }
    if (neutralCleared && unclearedLocales.size === 0) {
      writeTelegramMenuCommandHash(owner.hashKey, currentHash);
    } else {
      runtime.log?.("telegram: command menu cleanup incomplete; skipping success hash cache write");
    }
  };

  enqueueTelegramMenuSync({
    ownerKey: owner.queueKey,
    sync,
    onError: (error) => {
      runtime.error?.(`Telegram command sync failed: ${String(error)}`);
    },
  });
}
