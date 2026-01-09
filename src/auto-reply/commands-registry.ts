import type { ClawdbotConfig } from "../config/types.js";

export type ChatCommandDefinition = {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
  supportsNative?: boolean;
};

export type NativeCommandSpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

function defineChatCommand(
  command: Omit<ChatCommandDefinition, "textAliases"> & { textAlias: string },
): ChatCommandDefinition {
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    acceptsArgs: command.acceptsArgs,
    textAliases: [command.textAlias],
  };
}

function registerAlias(
  commands: ChatCommandDefinition[],
  key: string,
  ...aliases: string[]
): void {
  const command = commands.find((entry) => entry.key === key);
  if (!command) {
    throw new Error(`registerAlias: unknown command key: ${key}`);
  }
  const existing = new Set(command.textAliases.map((alias) => alias.trim()));
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) continue;
    if (existing.has(trimmed)) continue;
    existing.add(trimmed);
    command.textAliases.push(trimmed);
  }
}

export const CHAT_COMMANDS: ChatCommandDefinition[] = (() => {
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      key: "help",
      nativeName: "help",
      description: "Show available commands.",
      textAlias: "/help",
    }),
    defineChatCommand({
      key: "status",
      nativeName: "status",
      description: "Show current status.",
      textAlias: "/status",
    }),
    defineChatCommand({
      key: "debug",
      nativeName: "debug",
      description: "Set runtime debug overrides.",
      textAlias: "/debug",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "cost",
      nativeName: "cost",
      description: "Toggle per-response usage line.",
      textAlias: "/cost",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "stop",
      nativeName: "stop",
      description: "Stop the current run.",
      textAlias: "/stop",
    }),
    defineChatCommand({
      key: "restart",
      nativeName: "restart",
      description: "Restart Clawdbot.",
      textAlias: "/restart",
    }),
    defineChatCommand({
      key: "activation",
      nativeName: "activation",
      description: "Set group activation mode.",
      textAlias: "/activation",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "send",
      nativeName: "send",
      description: "Set send policy.",
      textAlias: "/send",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "reset",
      nativeName: "reset",
      description: "Reset the current session.",
      textAlias: "/reset",
    }),
    defineChatCommand({
      key: "new",
      nativeName: "new",
      description: "Start a new session.",
      textAlias: "/new",
    }),
    defineChatCommand({
      key: "think",
      nativeName: "think",
      description: "Set thinking level.",
      textAlias: "/think",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "verbose",
      nativeName: "verbose",
      description: "Toggle verbose mode.",
      textAlias: "/verbose",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "reasoning",
      nativeName: "reasoning",
      description: "Toggle reasoning visibility.",
      textAlias: "/reasoning",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "elevated",
      nativeName: "elevated",
      description: "Toggle elevated mode.",
      textAlias: "/elevated",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: "Show or set the model.",
      textAlias: "/model",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "queue",
      nativeName: "queue",
      description: "Adjust queue settings.",
      textAlias: "/queue",
      acceptsArgs: true,
    }),
  ];

  registerAlias(commands, "status", "/usage");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");
  registerAlias(commands, "model", "/models");

  return commands;
})();

const NATIVE_COMMAND_SURFACES = new Set(["discord", "slack", "telegram"]);

type TextAliasSpec = {
  canonical: string;
  acceptsArgs: boolean;
};

const TEXT_ALIAS_MAP: Map<string, TextAliasSpec> = (() => {
  const map = new Map<string, TextAliasSpec>();
  for (const command of CHAT_COMMANDS) {
    const canonical = `/${command.key}`;
    const acceptsArgs = Boolean(command.acceptsArgs);
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      if (!map.has(normalized)) {
        map.set(normalized, { canonical, acceptsArgs });
      }
    }
  }
  return map;
})();

let cachedDetection:
  | {
      exact: Set<string>;
      regex: RegExp;
    }
  | undefined;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function listChatCommands(): ChatCommandDefinition[] {
  return [...CHAT_COMMANDS];
}

export function listNativeCommandSpecs(): NativeCommandSpec[] {
  return CHAT_COMMANDS.filter(
    (command) => command.supportsNative !== false,
  ).map((command) => ({
    name: command.nativeName,
    description: command.description,
    acceptsArgs: Boolean(command.acceptsArgs),
  }));
}

export function findCommandByNativeName(
  name: string,
): ChatCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  return CHAT_COMMANDS.find(
    (command) => command.nativeName.toLowerCase() === normalized,
  );
}

export function buildCommandText(commandName: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}

export function normalizeCommandBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return trimmed;

  const colonMatch = trimmed.match(/^\/([^\s:]+)\s*:(.*)$/);
  const normalized = colonMatch
    ? (() => {
        const [, command, rest] = colonMatch;
        const normalizedRest = rest.trimStart();
        return normalizedRest ? `/${command} ${normalizedRest}` : `/${command}`;
      })()
    : trimmed;

  const lowered = normalized.toLowerCase();
  const exact = TEXT_ALIAS_MAP.get(lowered);
  if (exact) return exact.canonical;

  const tokenMatch = normalized.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) return normalized;
  const [, token, rest] = tokenMatch;
  const tokenKey = `/${token.toLowerCase()}`;
  const tokenSpec = TEXT_ALIAS_MAP.get(tokenKey);
  if (!tokenSpec) return normalized;
  if (rest && !tokenSpec.acceptsArgs) return normalized;
  const normalizedRest = rest?.trimStart();
  return normalizedRest
    ? `${tokenSpec.canonical} ${normalizedRest}`
    : tokenSpec.canonical;
}

export function getCommandDetection(): { exact: Set<string>; regex: RegExp } {
  if (cachedDetection) return cachedDetection;
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const command of CHAT_COMMANDS) {
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      exact.add(normalized);
      const escaped = escapeRegExp(normalized);
      if (!escaped) continue;
      if (command.acceptsArgs) {
        patterns.push(`${escaped}(?:\\s+.+|\\s*:\\s*.*)?`);
      } else {
        patterns.push(`${escaped}(?:\\s*:\\s*)?`);
      }
    }
  }
  const regex = patterns.length
    ? new RegExp(`^(?:${patterns.join("|")})$`, "i")
    : /$^/;
  cachedDetection = { exact, regex };
  return cachedDetection;
}

export function supportsNativeCommands(surface?: string): boolean {
  if (!surface) return false;
  return NATIVE_COMMAND_SURFACES.has(surface.toLowerCase());
}

export function shouldHandleTextCommands(params: {
  cfg: ClawdbotConfig;
  surface?: string;
  commandSource?: "text" | "native";
}): boolean {
  const { cfg, surface, commandSource } = params;
  const textEnabled = cfg.commands?.text !== false;
  if (commandSource === "native") return true;
  if (textEnabled) return true;
  return !supportsNativeCommands(surface);
}
