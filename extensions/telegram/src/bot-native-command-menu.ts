import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeTelegramCommandName, TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config.js";

const TELEGRAM_MAX_COMMANDS = 100;
export const TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET = 5700;
const TELEGRAM_COMMAND_RETRY_RATIO = 0.8;
const TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH = 1;

type TelegramMenuCommand = {
  command: string;
  description: string;
};

type TelegramPluginCommandSpec = {
  name: unknown;
  description: unknown;
};

function countTelegramCommandText(value: string): number {
  return Array.from(value).length;
}

function truncateTelegramCommandText(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }
  if (maxLength === 1) {
    return chars[0] ?? "";
  }
  return `${chars.slice(0, maxLength - 1).join("")}…`;
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
      const description = truncateTelegramCommandText(command.description, descriptionCap);
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
    commands.push({ command: normalized, description });
  }

  return { commands, issues };
}

export function buildCappedTelegramMenuCommands(params: {
  allCommands: TelegramMenuCommand[];
  maxCommands?: number;
  maxTotalChars?: number;
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
  const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
  const maxTotalChars = params.maxTotalChars ?? TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET;
  const totalCommands = allCommands.length;
  const overflowCount = Math.max(0, totalCommands - maxCommands);
  const {
    commands: commandsToRegister,
    descriptionTrimmed,
    textBudgetDropCount,
  } = fitTelegramCommandsWithinTextBudget(allCommands.slice(0, maxCommands), maxTotalChars);
  return {
    commandsToRegister,
    totalCommands,
    maxCommands,
    overflowCount,
    maxTotalChars,
    descriptionTrimmed,
    textBudgetDropCount,
  };
}

/** Compute a stable hash of the command list for change detection. */
export function hashCommandList(commands: TelegramMenuCommand[]): string {
  const sorted = [...commands].toSorted((a, b) => a.command.localeCompare(b.command));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

// Keep the sync cache process-local so restarts always re-register commands.
const syncedCommandHashes = new Map<string, string>();

function getCommandHashKey(accountId?: string, botIdentity?: string): string {
  return `${accountId ?? "default"}:${botIdentity ?? ""}`;
}

function readCachedCommandHash(accountId?: string, botIdentity?: string): string | null {
  const key = getCommandHashKey(accountId, botIdentity);
  return syncedCommandHashes.get(key) ?? null;
}

function writeCachedCommandHash(
  accountId: string | undefined,
  botIdentity: string | undefined,
  hash: string,
): void {
  const key = getCommandHashKey(accountId, botIdentity);
  syncedCommandHashes.set(key, hash);
}

export function syncTelegramMenuCommands(params: {
  bot: Bot;
  runtime: RuntimeEnv;
  commandsToRegister: TelegramMenuCommand[];
  accountId?: string;
  botIdentity?: string;
}): void {
  const { bot, runtime, commandsToRegister, accountId, botIdentity } = params;
  const sync = async () => {
    // Skip sync if the command list hasn't changed since the last successful
    // sync. This prevents hitting Telegram's 429 rate limit when the gateway
    // is restarted several times in quick succession.
    // See: openclaw/openclaw#32017
    const currentHash = hashCommandList(commandsToRegister);
    const cachedHash = readCachedCommandHash(accountId, botIdentity);
    if (cachedHash === currentHash) {
      logVerbose("telegram: command menu unchanged; skipping sync");
      return;
    }

    // Keep delete -> set ordering to avoid stale deletions racing after fresh registrations.
    let deleteSucceeded = true;
    if (typeof bot.api.deleteMyCommands === "function") {
      deleteSucceeded = await withTelegramApiErrorLogging({
        operation: "deleteMyCommands",
        runtime,
        fn: () => bot.api.deleteMyCommands(),
      })
        .then(() => true)
        .catch(() => false);
    }

    if (commandsToRegister.length === 0) {
      if (!deleteSucceeded) {
        runtime.log?.("telegram: deleteMyCommands failed; skipping empty-menu hash cache write");
        return;
      }
      writeCachedCommandHash(accountId, botIdentity, currentHash);
      return;
    }

    let retryCommands = commandsToRegister;
    const initialCommandCount = commandsToRegister.length;
    while (retryCommands.length > 0) {
      try {
        await withTelegramApiErrorLogging({
          operation: "setMyCommands",
          runtime,
          shouldLog: (err) => !isBotCommandsTooMuchError(err),
          fn: () => bot.api.setMyCommands(retryCommands),
        });
        if (retryCommands.length < initialCommandCount) {
          runtime.log?.(
            formatTelegramCommandRetrySuccessLog({
              initialCount: initialCommandCount,
              acceptedCount: retryCommands.length,
            }),
          );
        }
        writeCachedCommandHash(accountId, botIdentity, currentHash);
        return;
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
        retryCommands = retryCommands.slice(0, reducedCount);
      }
    }
  };

  void sync().catch((err) => {
    runtime.error?.(`Telegram command sync failed: ${String(err)}`);
  });
}
