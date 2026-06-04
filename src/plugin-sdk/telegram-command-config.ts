/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Use plugin-local Telegram command config handling for new plugin code.
 */

import {
  normalizeCommandDescription,
  normalizeSlashCommandName,
  resolveCustomCommands,
} from "../shared/custom-command-config.js";

/** Raw Telegram bot command entry from config. */
export type TelegramCustomCommandInput = {
  /** User-provided command name; leading slash is optional and removed during normalization. */
  command?: string | null;
  /** User-provided Bot API description, trimmed before validation. */
  description?: string | null;
};

/** Validation issue returned for one Telegram custom command entry. */
export type TelegramCustomCommandIssue = {
  /** Zero-based index of the command entry that failed validation. */
  index: number;
  /** Field that should be corrected in the raw command entry. */
  field: "command" | "description";
  /** Operator-facing validation message with the normalized command when available. */
  message: string;
};
const TELEGRAM_COMMAND_NAME_PATTERN_VALUE = /^[a-z0-9_]{1,32}$/;
const TELEGRAM_CUSTOM_COMMAND_CONFIG = {
  label: "Telegram",
  pattern: TELEGRAM_COMMAND_NAME_PATTERN_VALUE,
  patternDescription: "use a-z, 0-9, underscore; max 32 chars",
} as const;

function normalizeTelegramCommandNameImpl(value: string): string {
  return normalizeSlashCommandName(value);
}

function normalizeTelegramCommandDescriptionImpl(value: string): string {
  return normalizeCommandDescription(value);
}

function resolveTelegramCustomCommandsImpl(params: {
  commands?: TelegramCustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  // Keep the deprecated SDK subpath on the shared command validator so config,
  // doctor, and plugin-local Telegram flows report the same normalized issues.
  return resolveCustomCommands({
    ...params,
    config: TELEGRAM_CUSTOM_COMMAND_CONFIG,
  });
}

/** Returns the Telegram command-name regex accepted by Bot API menu commands. */
export function getTelegramCommandNamePattern(): RegExp {
  return TELEGRAM_COMMAND_NAME_PATTERN_VALUE;
}

/** Telegram Bot API command-name pattern: a-z, 0-9, underscore, max 32 chars. */
export const TELEGRAM_COMMAND_NAME_PATTERN = TELEGRAM_COMMAND_NAME_PATTERN_VALUE;

/** Normalizes user-provided Telegram command names into Bot API form. */
export function normalizeTelegramCommandName(
  /** Raw command name; leading slash is optional and dashes become underscores. */
  value: string,
): string {
  return normalizeTelegramCommandNameImpl(value);
}

/** Normalizes Telegram command descriptions for Bot API menu registration. */
export function normalizeTelegramCommandDescription(
  /** Raw command description, trimmed without other text rewriting. */
  value: string,
): string {
  return normalizeTelegramCommandDescriptionImpl(value);
}

/** Validates and normalizes configured Telegram custom commands. */
export function resolveTelegramCustomCommands(params: {
  /** Raw configured commands to normalize and validate in order. */
  commands?: TelegramCustomCommandInput[] | null;
  /** Native command names that custom commands must not shadow when reserved checks are enabled. */
  reservedCommands?: Set<string>;
  /** Set false to allow names that overlap native commands. */
  checkReserved?: boolean;
  /** Set false to allow duplicate normalized custom command names. */
  checkDuplicates?: boolean;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: TelegramCustomCommandIssue[];
} {
  return resolveTelegramCustomCommandsImpl(params);
}
