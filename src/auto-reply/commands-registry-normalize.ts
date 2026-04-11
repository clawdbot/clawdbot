import type { OpenClawConfig } from "../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { escapeRegExp } from "../utils.js";
import { getChatCommands } from "./commands-registry.data.js";
import type {
  ChatCommandDefinition,
  CommandDetection,
  CommandNormalizeOptions,
} from "./commands-registry.types.js";

type TextAliasSpec = {
  key: string;
  canonical: string;
  acceptsArgs: boolean;
};

let cachedTextAliasMap: Map<string, TextAliasSpec> | null = null;
let cachedTextAliasCommands: ChatCommandDefinition[] | null = null;
let cachedDetection: CommandDetection | undefined;
let cachedDetectionCommands: ChatCommandDefinition[] | null = null;

function getTextAliasMap(): Map<string, TextAliasSpec> {
  const commands = getChatCommands();
  if (cachedTextAliasMap && cachedTextAliasCommands === commands) {
    return cachedTextAliasMap;
  }
  const map = new Map<string, TextAliasSpec>();
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
      if (!map.has(normalized)) {
        map.set(normalized, { key: command.key, canonical, acceptsArgs });
      }
    }
  }
  cachedTextAliasMap = map;
  cachedTextAliasCommands = commands;
  return map;
}

export function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed;
  }

  const newline = trimmed.indexOf("\n");
  const singleLine = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();

  const colonMatch = singleLine.match(/^\/([^\s:]+)\s*:(.*)$/);
  const normalized = colonMatch
    ? (() => {
        const [, command, rest] = colonMatch;
        const normalizedRest = rest.trimStart();
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
  const textAliasMap = getTextAliasMap();
  const exact = textAliasMap.get(lowered);
  if (exact) {
    return exact.canonical;
  }

  const tokenMatch = commandBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) {
    return commandBody;
  }
  const [, token, rest] = tokenMatch;
  const tokenKey = `/${normalizeLowercaseStringOrEmpty(token)}`;
  const tokenSpec = textAliasMap.get(tokenKey);
  if (!tokenSpec) {
    return commandBody;
  }
  if (rest && !tokenSpec.acceptsArgs) {
    return commandBody;
  }
  const normalizedRest = rest?.trimStart();
  return normalizedRest ? `${tokenSpec.canonical} ${normalizedRest}` : tokenSpec.canonical;
}

export function getCommandDetection(_cfg?: OpenClawConfig): CommandDetection {
  const commands = getChatCommands();
  if (cachedDetection && cachedDetectionCommands === commands) {
    return cachedDetection;
  }
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const cmd of commands) {
    for (const alias of cmd.textAliases) {
      const normalized = normalizeOptionalLowercaseString(alias);
      if (!normalized) {
        continue;
      }
      exact.add(normalized);
      const escaped = escapeRegExp(normalized);
      if (!escaped) {
        continue;
      }
      if (cmd.acceptsArgs) {
        patterns.push(`${escaped}(?:\\s+.+|\\s*:\\s*.*)?`);
      } else {
        patterns.push(`${escaped}(?:\\s*:\\s*)?`);
      }
    }
  }
  cachedDetection = {
    exact,
    regex: patterns.length ? new RegExp(`^(?:${patterns.join("|")})$`, "i") : /$^/,
  };
  cachedDetectionCommands = commands;
  return cachedDetection;
}

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
  return getTextAliasMap().has(tokenKey) ? tokenKey : null;
}

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
  const spec = getTextAliasMap().get(alias);
  if (!spec) {
    return null;
  }
  const command = getChatCommands().find((entry) => entry.key === spec.key);
  if (!command) {
    return null;
  }
  if (!spec.acceptsArgs) {
    return { command };
  }
  const args = trimmed.slice(alias.length).trim();
  return { command, args: args || undefined };
}
