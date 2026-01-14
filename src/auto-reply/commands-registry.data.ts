import { listChannelDocks } from "../channels/dock.js";
import type {
  ChatCommandDefinition,
  CommandScope,
} from "./commands-registry.types.js";

type DefineChatCommandInput = {
  key: string;
  nativeName?: string;
  description: string;
  acceptsArgs?: boolean;
  textAlias?: string;
  textAliases?: string[];
  scope?: CommandScope;
};

function defineChatCommand(
  command: DefineChatCommandInput,
): ChatCommandDefinition {
  const aliases = (
    command.textAliases ?? (command.textAlias ? [command.textAlias] : [])
  )
    .map((alias) => alias.trim())
    .filter(Boolean);
  const scope =
    command.scope ??
    (command.nativeName ? (aliases.length ? "both" : "native") : "text");
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    acceptsArgs: command.acceptsArgs,
    textAliases: aliases,
    scope,
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
  const existing = new Set(
    command.textAliases.map((alias) => alias.trim().toLowerCase()),
  );
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) continue;
    const lowered = trimmed.toLowerCase();
    if (existing.has(lowered)) continue;
    existing.add(lowered);
    command.textAliases.push(trimmed);
  }
}

function assertCommandRegistry(commands: ChatCommandDefinition[]): void {
  const keys = new Set<string>();
  const nativeNames = new Set<string>();
  const textAliases = new Set<string>();
  for (const command of commands) {
    if (keys.has(command.key)) {
      throw new Error(`Duplicate command key: ${command.key}`);
    }
    keys.add(command.key);

    const nativeName = command.nativeName?.trim();
    if (command.scope === "text") {
      if (nativeName) {
        throw new Error(`Text-only command has native name: ${command.key}`);
      }
      if (command.textAliases.length === 0) {
        throw new Error(`Text-only command missing text alias: ${command.key}`);
      }
    } else if (!nativeName) {
      throw new Error(`Native command missing native name: ${command.key}`);
    } else {
      const nativeKey = nativeName.toLowerCase();
      if (nativeNames.has(nativeKey)) {
        throw new Error(`Duplicate native command: ${nativeName}`);
      }
      nativeNames.add(nativeKey);
    }

    if (command.scope === "native" && command.textAliases.length > 0) {
      throw new Error(`Native-only command has text aliases: ${command.key}`);
    }

    for (const alias of command.textAliases) {
      if (!alias.startsWith("/")) {
        throw new Error(`Command alias missing leading '/': ${alias}`);
      }
      const aliasKey = alias.toLowerCase();
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
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
      key: "commands",
      nativeName: "commands",
      description: "List all slash commands.",
      textAlias: "/commands",
    }),
    defineChatCommand({
      key: "status",
      nativeName: "status",
      description: "Show current status.",
      textAlias: "/status",
    }),
    defineChatCommand({
      key: "whoami",
      nativeName: "whoami",
      description: "Show your sender id.",
      textAlias: "/whoami",
    }),
    defineChatCommand({
      key: "config",
      nativeName: "config",
      description: "Show or set config values.",
      textAlias: "/config",
      acceptsArgs: true,
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
      key: "compact",
      description: "Compact the session context.",
      textAlias: "/compact",
      scope: "text",
      acceptsArgs: true,
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
    defineChatCommand({
      key: "bash",
      description: "Run host shell commands (host-only).",
      textAlias: "/bash",
      scope: "text",
      acceptsArgs: true,
    }),
    ...listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) =>
        defineChatCommand({
          key: `dock:${dock.id}`,
          nativeName: `dock-${dock.id}`,
          description: `Switch to ${dock.id} for replies.`,
          textAlias: `/dock-${dock.id}`,
          acceptsArgs: false,
        }),
      ),
  ];

  registerAlias(commands, "status", "/usage");
  registerAlias(commands, "whoami", "/id");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");
  registerAlias(commands, "model", "/models");

  assertCommandRegistry(commands);
  return commands;
})();

let cachedNativeCommandSurfaces: Set<string> | null = null;

export const getNativeCommandSurfaces = (): Set<string> => {
  if (!cachedNativeCommandSurfaces) {
    cachedNativeCommandSurfaces = new Set(
      listChannelDocks()
        .filter((dock) => dock.capabilities.nativeCommands)
        .map((dock) => dock.id),
    );
  }
  return cachedNativeCommandSurfaces;
};
