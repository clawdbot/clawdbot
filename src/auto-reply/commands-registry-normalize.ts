import { expectDefined } from "@openclaw/normalization-core";
/** Normalizes slash-command text aliases and builds command detection caches. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { escapeRegExp } from "../utils.js";
import { getChatCommands } from "./commands-registry.data.js";
import type {
  ChatCommandDefinition,
  CommandDetection,
  CommandNormalizeOptions,
} from "./commands-registry.types.js";

type TextAliasSpec = {
  command: ChatCommandDefinition;
  canonical: string;
  acceptsArgs: boolean;
};

type CommandRegistryLookup = {
  commands: ChatCommandDefinition[];
  aliases: Map<string, TextAliasSpec>;
  detection: CommandDetection;
};

let cachedRegistryLookup: CommandRegistryLookup | undefined;

function appendMultilineTail(head: string, tail: string | undefined, spec?: TextAliasSpec): string {
  if (!tail) {
    return head;
  }
  if (!spec || spec.command.key === "skill" || spec.command.key === "learn") {
    return `${head}\n${tail}`;
  }
  if (spec.command.key === "reset") {
    const flattened = tail.replace(/\s+/g, " ").trim();
    return flattened ? `${head} ${flattened}` : head;
  }
  return head;
}

function getCommandRegistryLookup(): CommandRegistryLookup {
  const commands = getChatCommands();
  if (cachedRegistryLookup?.commands === commands) {
    return cachedRegistryLookup;
  }
  const aliases = new Map<string, TextAliasSpec>();
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const command of commands) {
    // Canonicalize to the primary text alias, not `/${key}`. Some command keys are
    // internal identifiers while the public text command is a dedicated alias.
    const canonical = normalizeOptionalString(command.textAliases[0]) || `/${command.key}`;
    const acceptsArgs = Boolean(command.acceptsArgs);
    for (const alias of command.textAliases) {
      const normalized = normalizeOptionalLowercaseString(alias);
      if (!normalized) {
        continue;
      }
      if (!aliases.has(normalized)) {
        aliases.set(normalized, { command, canonical, acceptsArgs });
      }
      exact.add(normalized);
      const escaped = escapeRegExp(normalized);
      patterns.push(
        acceptsArgs
          ? `${escaped}(?:\\s+[\\s\\S]+|\\s*:\\s*[\\s\\S]*)?`
          : `${escaped}(?:\\s*:\\s*)?`,
      );
    }
  }
  cachedRegistryLookup = {
    commands,
    aliases,
    detection: {
      exact,
      regex: patterns.length ? new RegExp(`^(?:${patterns.join("|")})$`, "i") : /$^/,
    },
  };
  return cachedRegistryLookup;
}

/** Normalizes command text to canonical aliases, removing bot mentions when appropriate. */
export function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed;
  }

  const newline = trimmed.indexOf("\n");
  const singleLine = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
  const multilineTail = newline === -1 ? undefined : trimmed.slice(newline + 1).trimStart();

  // `/cmd: value` is accepted as `/cmd value` because some channels insert colon syntax.
  const colonMatch = singleLine.match(/^\/([^\s:]+)\s*:(.*)$/);
  const normalized = colonMatch
    ? (() => {
        const [, command, rest] = colonMatch;
        const normalizedRest = expectDefined(rest, "commands registry normalize rest").trimStart();
        return normalizedRest ? `/${command} ${normalizedRest}` : `/${command}`;
      })()
    : singleLine;

  const normalizedBotUsername = normalizeOptionalLowercaseString(options?.botUsername);
  const mentionMatch = normalizedBotUsername
    ? normalized.match(/^\/([^\s@]+)@([^\s]+)(.*)$/)
    : null;
  const commandBody =
    mentionMatch && normalizeLowercaseStringOrEmpty(mentionMatch[2]) === normalizedBotUsername
      ? `/${mentionMatch[1]}${mentionMatch[3] ?? ""}`
      : normalized;

  const lowered = normalizeLowercaseStringOrEmpty(commandBody);
  const textAliasMap = getCommandRegistryLookup().aliases;
  const exact = textAliasMap.get(lowered);
  if (exact) {
    return appendMultilineTail(exact.canonical, multilineTail, exact);
  }

  const tokenMatch = commandBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) {
    return appendMultilineTail(commandBody, multilineTail);
  }
  const [, token, rest] = tokenMatch;
  const tokenKey = `/${normalizeLowercaseStringOrEmpty(token)}`;
  const tokenSpec = textAliasMap.get(tokenKey);
  if (!tokenSpec) {
    return appendMultilineTail(commandBody, multilineTail);
  }
  if (rest && !tokenSpec.acceptsArgs) {
    return commandBody;
  }
  const normalizedRest = rest?.trimStart();
  const normalizedHead = normalizedRest
    ? `${tokenSpec.canonical} ${normalizedRest}`
    : tokenSpec.canonical;
  return appendMultilineTail(normalizedHead, multilineTail, tokenSpec);
}

/** Returns cached exact and regex detectors for the current command registry instance. */
export function getCommandDetection(_cfg?: OpenClawConfig): CommandDetection {
  return getCommandRegistryLookup().detection;
}

/** Resolves a raw text command to the matching normalized alias when known. */
export function maybeResolveTextAlias(raw: string, cfg?: OpenClawConfig) {
  const trimmed = normalizeCommandBody(raw).trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const detection = getCommandDetection(cfg);
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (detection.exact.has(normalized)) {
    return normalized;
  }
  if (!detection.regex.test(normalized)) {
    return null;
  }
  const tokenMatch = normalized.match(/^\/([^\s:]+)(?:\s|$)/);
  if (!tokenMatch) {
    return null;
  }
  const tokenKey = `/${tokenMatch[1]}`;
  return getCommandRegistryLookup().aliases.has(tokenKey) ? tokenKey : null;
}

/** Resolves a raw text command into its command definition and raw argument tail. */
export function resolveTextCommand(
  raw: string,
  cfg?: OpenClawConfig,
): {
  command: ChatCommandDefinition;
  args?: string;
} | null {
  const trimmed = normalizeCommandBody(raw).trim();
  const alias = maybeResolveTextAlias(trimmed, cfg);
  if (!alias) {
    return null;
  }
  const spec = getCommandRegistryLookup().aliases.get(alias);
  if (!spec) {
    return null;
  }
  if (!spec.acceptsArgs) {
    return { command: spec.command };
  }
  const args = trimmed.slice(alias.length).trim();
  return { command: spec.command, args: args || undefined };
}
