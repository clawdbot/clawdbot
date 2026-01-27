import type { MoltbotConfig } from "../config/types.js";
import type { SkillCommandSpec } from "../agents/skills.js";
import { getChatCommands, getNativeCommandSurfaces } from "./commands-registry.data.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  NativeCommandSpec,
  ShouldHandleTextCommandsParams,
} from "./commands-registry.types.js";

export type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  CommandScope,
  NativeCommandSpec,
  ShouldHandleTextCommandsParams,
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
  if (cachedTextAliasMap && cachedTextAliasCommands === commands) return cachedTextAliasMap;
  const map = new Map<string, TextAliasSpec>();
  for (const command of commands) {
    // Canonicalize to the *primary* text alias, not `/${key}`. Some command keys are
    // internal identifiers (e.g. `dock:telegram`) while the public text command is
    // the alias (e.g. `/dock-telegram`).
    const canonical = command.textAliases[0]?.trim() || `/${command.key}`;
    const acceptsArgs = Boolean(command.acceptsArgs);
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      if (!map.has(normalized)) {
        map.set(normalized, { key: command.key, canonical, acceptsArgs });
      }
    }
  }
  cachedTextAliasMap = map;
  cachedTextAliasCommands = commands;
  return map;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSkillCommandDefinitions(skillCommands?: SkillCommandSpec[]): ChatCommandDefinition[] {
  if (!skillCommands || skillCommands.length === 0) return [];
  return skillCommands.map((spec) => ({
    key: `skill:${spec.skillName}`,
    nativeName: spec.name,
    description: spec.description,
    textAliases: [`/${spec.name}`],
    acceptsArgs: true,
    argsParsing: "none",
    scope: "both",
  }));
}

export function listChatCommands(params?: {
  skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[] {
  const commands = getChatCommands();
  if (!params?.skillCommands?.length) return [...commands];
  return [...commands, ...buildSkillCommandDefinitions(params.skillCommands)];
}

export function isCommandEnabled(cfg: MoltbotConfig, commandKey: string): boolean {
  if (commandKey === "config") return cfg.commands?.config === true;
  if (commandKey === "debug") return cfg.commands?.debug === true;
  if (commandKey === "bash") return cfg.commands?.bash === true;
  return true;
}

export function listChatCommandsForConfig(
  cfg: MoltbotConfig,
  params?: { skillCommands?: SkillCommandSpec[] },
): ChatCommandDefinition[] {
  const base = getChatCommands().filter((command) => isCommandEnabled(cfg, command.key));
  if (!params?.skillCommands?.length) return base;
  return [...base, ...buildSkillCommandDefinitions(params.skillCommands)];
}

const NATIVE_NAME_OVERRIDES: Record<string, Record<string, string>> = {
  discord: {
    tts: "voice",
  },
};

function resolveNativeName(command: ChatCommandDefinition, provider?: string): string | undefined {
  if (!command.nativeName) return undefined;
  if (provider) {
    const override = NATIVE_NAME_OVERRIDES[provider]?.[command.key];
    if (override) return override;
  }
  return command.nativeName;
}

export function listNativeCommandSpecs(params?: {
  skillCommands?: SkillCommandSpec[];
  provider?: string;
}): NativeCommandSpec[] {
  return listChatCommands({ skillCommands: params?.skillCommands })
    .filter((command) => command.scope !== "text" && command.nativeName)
    .map((command) => ({
      name: resolveNativeName(command, params?.provider) ?? command.key,
      description: command.description,
      acceptsArgs: Boolean(command.acceptsArgs),
      args: command.args,
    }));
}

export function listNativeCommandSpecsForConfig(
  cfg: MoltbotConfig,
  params?: { skillCommands?: SkillCommandSpec[]; provider?: string },
): NativeCommandSpec[] {
  return listChatCommandsForConfig(cfg, params)
    .filter((command) => command.scope !== "text" && command.nativeName)
    .map((command) => ({
      name: resolveNativeName(command, params?.provider) ?? command.key,
      description: command.description,
      acceptsArgs: Boolean(command.acceptsArgs),
      args: command.args,
    }));
}

export function findCommandByNativeName(
  name: string,
  provider?: string,
): ChatCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  return getChatCommands().find(
    (command) =>
      command.scope !== "text" &&
      resolveNativeName(command, provider)?.toLowerCase() === normalized,
  );
}

export function buildCommandText(commandName: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}

function parsePositionalArgs(definitions: CommandArgDefinition[], raw: string): CommandArgValues {
  const values: CommandArgValues = {};
  const trimmed = raw.trim();
  if (!trimmed) return values;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let index = 0;
  for (const definition of definitions) {
    if (index >= tokens.length) break;
    if (definition.captureRemaining) {
      values[definition.name] = tokens.slice(index).join(" ");
      index = tokens.length;
      break;
    }
    values[definition.name] = tokens[index];
    index += 1;
  }
  return values;
}

function formatPositionalArgs(
  definitions: CommandArgDefinition[],
  values: CommandArgValues,
): string | undefined {
  const parts: string[] = [];
  for (const definition of definitions) {
    const value = values[definition.name];
    if (value == null) continue;
    let rendered: string;
    if (typeof value === "string") {
      rendered = value.trim();
    } else {
      rendered = String(value);
    }
    if (!rendered) continue;
    parts.push(rendered);
    if (definition.captureRemaining) break;
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function parseCommandArgs(
  command: ChatCommandDefinition,
  raw?: string,
): CommandArgs | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!command.args || command.argsParsing === "none") {
    return { raw: trimmed };
  }
  return {
    raw: trimmed,
    values: parsePositionalArgs(command.args, trimmed),
  };
}

export function serializeCommandArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string | undefined {
  if (!args) return undefined;
  const raw = args.raw?.trim();
  if (raw) return raw;
  if (!args.values || !command.args) return undefined;
  if (command.formatArgs) return command.formatArgs(args.values);
  return formatPositionalArgs(command.args, args.values);
}

export function buildCommandTextFromArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string {
  const commandName = command.nativeName ?? command.key;
  return buildCommandText(commandName, serializeCommandArgs(command, args));
}

function resolveDefaultCommandContext(cfg?: MoltbotConfig): {
  provider: string;
  model: string;
} {
  const resolved = resolveConfiguredModelRef({
    cfg: cfg ?? ({} as MoltbotConfig),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  return {
    provider: resolved.provider ?? DEFAULT_PROVIDER,
    model: resolved.model ?? DEFAULT_MODEL,
  };
}

export type ResolvedCommandArgChoice = { value: string; label: string };

export function resolveCommandArgChoices(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  cfg?: MoltbotConfig;
  provider?: string;
  model?: string;
}): ResolvedCommandArgChoice[] {
  const { command, arg, cfg } = params;
  if (!arg.choices) return [];
  const provided = arg.choices;
  const raw = Array.isArray(provided)
    ? provided
    : (() => {
        const defaults = resolveDefaultCommandContext(cfg);
        const context: CommandArgChoiceContext = {
          cfg,
          provider: params.provider ?? defaults.provider,
          model: params.model ?? defaults.model,
          command,
          arg,
        };
        return provided(context);
      })();
  return raw.map((choice) =>
    typeof choice === "string" ? { value: choice, label: choice } : choice,
  );
}

export function resolveCommandArgMenu(params: {
  command: ChatCommandDefinition;
  args?: CommandArgs;
  cfg?: MoltbotConfig;
}): { arg: CommandArgDefinition; choices: ResolvedCommandArgChoice[]; title?: string } | null {
  const { command, args, cfg } = params;
  if (!command.args || !command.argsMenu) return null;
  if (command.argsParsing === "none") return null;
  const argSpec = command.argsMenu;
  const argName =
    argSpec === "auto"
      ? command.args.find((arg) => resolveCommandArgChoices({ command, arg, cfg }).length > 0)?.name
      : argSpec.arg;
  if (!argName) return null;
  if (args?.values && args.values[argName] != null) return null;
  if (args?.raw && !args.values) return null;
  const arg = command.args.find((entry) => entry.name === argName);
  if (!arg) return null;
  const choices = resolveCommandArgChoices({ command, arg, cfg });
  if (choices.length === 0) return null;
  const title = argSpec !== "auto" ? argSpec.title : undefined;
  return { arg, choices, title };
}

export function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return trimmed;

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

  const normalizedBotUsername = options?.botUsername?.trim().toLowerCase();
  const mentionMatch = normalizedBotUsername
    ? normalized.match(/^\/([^\s@]+)@([^\s]+)(.*)$/)
    : null;
  const commandBody =
    mentionMatch && mentionMatch[2].toLowerCase() === normalizedBotUsername
      ? `/${mentionMatch[1]}${mentionMatch[3] ?? ""}`
      : normalized;

  const lowered = commandBody.toLowerCase();
  const textAliasMap = getTextAliasMap();
  const exact = textAliasMap.get(lowered);
  if (exact) return exact.canonical;

  const tokenMatch = commandBody.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) return commandBody;
  const [, token, rest] = tokenMatch;
  const tokenKey = `/${token.toLowerCase()}`;
  const tokenSpec = textAliasMap.get(tokenKey);
  if (!tokenSpec) return commandBody;
  if (rest && !tokenSpec.acceptsArgs) return commandBody;
  const normalizedRest = rest?.trimStart();
  return normalizedRest ? `${tokenSpec.canonical} ${normalizedRest}` : tokenSpec.canonical;
}

export function isCommandMessage(raw: string): boolean {
  const trimmed = normalizeCommandBody(raw);
  return trimmed.startsWith("/");
}

export function getCommandDetection(_cfg?: MoltbotConfig): CommandDetection {
  const commands = getChatCommands();
  if (cachedDetection && cachedDetectionCommands === commands) return cachedDetection;
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const cmd of commands) {
    for (const alias of cmd.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      exact.add(normalized);
      const escaped = escapeRegExp(normalized);
      if (!escaped) continue;
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

export function maybeResolveTextAlias(raw: string, cfg?: MoltbotConfig) {
  const trimmed = normalizeCommandBody(raw).trim();
  if (!trimmed.startsWith("/")) return null;
  const detection = getCommandDetection(cfg);
  const normalized = trimmed.toLowerCase();
  if (detection.exact.has(normalized)) return normalized;
  if (!detection.regex.test(normalized)) return null;
  const tokenMatch = normalized.match(/^\/([^\s:]+)(?:\s|$)/);
  if (!tokenMatch) return null;
  const tokenKey = `/${tokenMatch[1]}`;
  return getTextAliasMap().has(tokenKey) ? tokenKey : null;
}

export function resolveTextCommand(
  raw: string,
  cfg?: MoltbotConfig,
): {
  command: ChatCommandDefinition;
  args?: string;
} | null {
  const trimmed = normalizeCommandBody(raw).trim();
  const alias = maybeResolveTextAlias(trimmed, cfg);
  if (!alias) return null;
  const spec = getTextAliasMap().get(alias);
  if (!spec) return null;
  const command = getChatCommands().find((entry) => entry.key === spec.key);
  if (!command) return null;
  if (!spec.acceptsArgs) return { command };
  const args = trimmed.slice(alias.length).trim();
  return { command, args: args || undefined };
}

export function isNativeCommandSurface(surface?: string): boolean {
  if (!surface) return false;
  return getNativeCommandSurfaces().has(surface.toLowerCase());
}

export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native") return true;
  if (params.cfg.commands?.text !== false) return true;
  return !isNativeCommandSurface(params.surface);
}
