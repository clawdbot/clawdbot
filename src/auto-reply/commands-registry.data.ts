import { listChannelDocks } from "../channels/dock.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { listThinkingLevels } from "./thinking.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import type { ChatCommandDefinition, CommandScope } from "./commands-registry.types.js";

type DefineChatCommandInput = {
  key: string;
  nativeName?: string;
  description: string;
  args?: ChatCommandDefinition["args"];
  argsParsing?: ChatCommandDefinition["argsParsing"];
  formatArgs?: ChatCommandDefinition["formatArgs"];
  argsMenu?: ChatCommandDefinition["argsMenu"];
  acceptsArgs?: boolean;
  textAlias?: string;
  textAliases?: string[];
  scope?: CommandScope;
};

function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition {
  const aliases = (command.textAliases ?? (command.textAlias ? [command.textAlias] : []))
    .map((alias) => alias.trim())
    .filter(Boolean);
  const scope =
    command.scope ?? (command.nativeName ? (aliases.length ? "both" : "native") : "text");
  const acceptsArgs = command.acceptsArgs ?? Boolean(command.args?.length);
  const argsParsing = command.argsParsing ?? (command.args?.length ? "positional" : "none");
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    acceptsArgs,
    args: command.args,
    argsParsing,
    formatArgs: command.formatArgs,
    argsMenu: command.argsMenu,
    textAliases: aliases,
    scope,
  };
}

type ChannelDock = ReturnType<typeof listChannelDocks>[number];

function defineDockCommand(dock: ChannelDock): ChatCommandDefinition {
  return defineChatCommand({
    key: `dock:${dock.id}`,
    nativeName: `dock_${dock.id}`,
    description: `Switch to ${dock.id} for replies.`,
    textAliases: [`/dock-${dock.id}`, `/dock_${dock.id}`],
  });
}

function registerAlias(commands: ChatCommandDefinition[], key: string, ...aliases: string[]): void {
  const command = commands.find((entry) => entry.key === key);
  if (!command) {
    throw new Error(`registerAlias: unknown command key: ${key}`);
  }
  const existing = new Set(command.textAliases.map((alias) => alias.trim().toLowerCase()));
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

let cachedCommands: ChatCommandDefinition[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function buildChatCommands(): ChatCommandDefinition[] {
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
      key: "skill",
      nativeName: "skill",
      description: "Run a skill by name.",
      textAlias: "/skill",
      args: [
        {
          name: "name",
          description: "Skill name",
          type: "string",
          required: true,
        },
        {
          name: "input",
          description: "Skill input",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "status",
      nativeName: "status",
      description: "Show current status.",
      textAlias: "/status",
    }),
    defineChatCommand({
      key: "allowlist",
      description: "List/add/remove allowlist entries.",
      textAlias: "/allowlist",
      acceptsArgs: true,
      scope: "text",
    }),
    defineChatCommand({
      key: "context",
      nativeName: "context",
      description: "Explain how context is built and used.",
      textAlias: "/context",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "whoami",
      nativeName: "whoami",
      description: "Show your sender id.",
      textAlias: "/whoami",
    }),
    defineChatCommand({
      key: "subagents",
      nativeName: "subagents",
      description: "List/stop/log/info subagent runs for this session.",
      textAlias: "/subagents",
      args: [
        {
          name: "action",
          description: "list | stop | log | info | send",
          type: "string",
          choices: ["list", "stop", "log", "info", "send"],
        },
        {
          name: "target",
          description: "Run id, index, or session key",
          type: "string",
        },
        {
          name: "value",
          description: "Additional input (limit/message)",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "config",
      nativeName: "config",
      description: "Show or set config values.",
      textAlias: "/config",
      args: [
        {
          name: "action",
          description: "show | get | set | unset",
          type: "string",
          choices: ["show", "get", "set", "unset"],
        },
        {
          name: "path",
          description: "Config path",
          type: "string",
        },
        {
          name: "value",
          description: "Value for set",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.config,
    }),
    defineChatCommand({
      key: "debug",
      nativeName: "debug",
      description: "Set runtime debug overrides.",
      textAlias: "/debug",
      args: [
        {
          name: "action",
          description: "show | reset | set | unset",
          type: "string",
          choices: ["show", "reset", "set", "unset"],
        },
        {
          name: "path",
          description: "Debug path",
          type: "string",
        },
        {
          name: "value",
          description: "Value for set",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.debug,
    }),
    defineChatCommand({
      key: "usage",
      nativeName: "usage",
      description: "Usage footer or cost summary.",
      textAlias: "/usage",
      args: [
        {
          name: "mode",
          description: "off, tokens, full, or cost",
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
      argsMenu: "auto",
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
      args: [
        {
          name: "mode",
          description: "mention or always",
          type: "string",
          choices: ["mention", "always"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "send",
      nativeName: "send",
      description: "Set send policy.",
      textAlias: "/send",
      args: [
        {
          name: "mode",
          description: "on, off, or inherit",
          type: "string",
          choices: ["on", "off", "inherit"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reset",
      nativeName: "reset",
      description: "Reset the current session.",
      textAlias: "/reset",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "new",
      nativeName: "new",
      description: "Start a new session.",
      textAlias: "/new",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "compact",
      description: "Compact the session context.",
      textAlias: "/compact",
      scope: "text",
      args: [
        {
          name: "instructions",
          description: "Extra compaction instructions",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "think",
      nativeName: "think",
      description: "Set thinking level.",
      textAlias: "/think",
      args: [
        {
          name: "level",
          description: "off, minimal, low, medium, high, xhigh",
          type: "string",
          choices: ({ provider, model }) => listThinkingLevels(provider, model),
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "verbose",
      nativeName: "verbose",
      description: "Toggle verbose mode.",
      textAlias: "/verbose",
      args: [
        {
          name: "mode",
          description: "on or off",
          type: "string",
          choices: ["on", "off"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reasoning",
      nativeName: "reasoning",
      description: "Toggle reasoning visibility.",
      textAlias: "/reasoning",
      args: [
        {
          name: "mode",
          description: "on, off, or stream",
          type: "string",
          choices: ["on", "off", "stream"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "elevated",
      nativeName: "elevated",
      description: "Toggle elevated mode.",
      textAlias: "/elevated",
      args: [
        {
          name: "mode",
          description: "on or off",
          type: "string",
          choices: ["on", "off"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "exec",
      nativeName: "exec",
      description: "Set exec defaults for this session.",
      textAlias: "/exec",
      args: [
        {
          name: "options",
          description: "host=... security=... ask=... node=...",
          type: "string",
        },
      ],
      argsParsing: "none",
    }),
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: "Show or set the model.",
      textAlias: "/model",
      args: [
        {
          name: "model",
          description: "Model id (provider/model or id)",
          type: "string",
        },
      ],
    }),
    defineChatCommand({
      key: "models",
      nativeName: "models",
      description: "List model providers or provider models.",
      textAlias: "/models",
      argsParsing: "none",
      acceptsArgs: true,
    }),
    defineChatCommand({
      key: "queue",
      nativeName: "queue",
      description: "Adjust queue settings.",
      textAlias: "/queue",
      args: [
        {
          name: "mode",
          description: "queue mode",
          type: "string",
          choices: ["steer", "interrupt", "followup", "collect", "steer-backlog"],
        },
        {
          name: "debounce",
          description: "debounce duration (e.g. 500ms, 2s)",
          type: "string",
        },
        {
          name: "cap",
          description: "queue cap",
          type: "number",
        },
        {
          name: "drop",
          description: "drop policy",
          type: "string",
          choices: ["old", "new", "summarize"],
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.queue,
    }),
    defineChatCommand({
      key: "bash",
      description: "Run host shell commands (host-only).",
      textAlias: "/bash",
      scope: "text",
      args: [
        {
          name: "command",
          description: "Shell command",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    ...listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) => defineDockCommand(dock)),
  ];

  registerAlias(commands, "whoami", "/id");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");

  assertCommandRegistry(commands);
  return commands;
}

export function getChatCommands(): ChatCommandDefinition[] {
  const registry = getActivePluginRegistry();
  if (cachedCommands && registry === cachedRegistry) return cachedCommands;
  const commands = buildChatCommands();
  cachedCommands = commands;
  cachedRegistry = registry;
  cachedNativeCommandSurfaces = null;
  return commands;
}

export function getNativeCommandSurfaces(): Set<string> {
  const registry = getActivePluginRegistry();
  if (cachedNativeCommandSurfaces && registry === cachedNativeRegistry) {
    return cachedNativeCommandSurfaces;
  }
  cachedNativeCommandSurfaces = new Set(
    listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) => dock.id),
  );
  cachedNativeRegistry = registry;
  return cachedNativeCommandSurfaces;
}
