// Custom command config helpers normalize command configuration records.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Raw custom slash-command entry from config. */
type CustomCommandInput = {
  command?: string | null;
  description?: string | null;
};

/** Validation issue for one configured custom command. */
type CustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};

/** Command validation policy for one command family. */
type CustomCommandConfig = {
  label: string;
  pattern: RegExp;
  patternDescription: string;
  prefix?: string;
};

const DEFAULT_PREFIX = "/";

/** Normalize a slash command name to the internal lowercase underscore form. */
export function normalizeSlashCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSlash = trimmed.startsWith(DEFAULT_PREFIX) ? trimmed.slice(1) : trimmed;
  return normalizeLowercaseStringOrEmpty(withoutSlash).replace(/-/g, "_");
}

/** Normalize command descriptions without changing user-authored wording. */
export function normalizeCommandDescription(value: string): string {
  return value.trim();
}

/** Validate and normalize custom command config entries. */
export function resolveCustomCommands(params: {
  commands?: CustomCommandInput[] | null;
  reservedCommands?: Set<string>;
  checkReserved?: boolean;
  checkDuplicates?: boolean;
  config: CustomCommandConfig;
}): {
  commands: Array<{ command: string; description: string }>;
  issues: CustomCommandIssue[];
} {
  const entries = Array.isArray(params.commands) ? params.commands : [];
  const reserved = params.reservedCommands ?? new Set<string>();
  const checkReserved = params.checkReserved !== false;
  const checkDuplicates = params.checkDuplicates !== false;
  const seen = new Set<string>();
  const resolved: Array<{ command: string; description: string }> = [];
  const issues: CustomCommandIssue[] = [];
  const label = params.config.label;
  const prefix = params.config.prefix ?? DEFAULT_PREFIX;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // Accumulate issues instead of throwing so config UIs and CLIs can present
    // all invalid commands in one pass.
    const normalized = normalizeSlashCommandName(entry?.command ?? "");
    if (!normalized) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command is missing a command name.`,
      });
      continue;
    }
    if (!params.config.pattern.test(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command "${prefix}${normalized}" is invalid (${params.config.patternDescription}).`,
      });
      continue;
    }
    if (checkReserved && reserved.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command "${prefix}${normalized}" conflicts with a native command.`,
      });
      continue;
    }
    if (checkDuplicates && seen.has(normalized)) {
      issues.push({
        index,
        field: "command",
        message: `${label} custom command "${prefix}${normalized}" is duplicated.`,
      });
      continue;
    }
    const description = normalizeCommandDescription(entry?.description ?? "");
    if (!description) {
      issues.push({
        index,
        field: "description",
        message: `${label} custom command "${prefix}${normalized}" is missing a description.`,
      });
      continue;
    }
    if (checkDuplicates) {
      seen.add(normalized);
    }
    resolved.push({ command: normalized, description });
  }

  return { commands: resolved, issues };
}
