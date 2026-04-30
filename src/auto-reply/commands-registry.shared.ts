import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import type {
  ChatCommandDefinition,
  CommandCategory,
  CommandScope,
  CommandTier,
} from "./commands-registry.types.js";
import { listThinkingLevels } from "./thinking.js";

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
  category?: CommandCategory;
  /** Progressive disclosure tier. Defaults to "standard". */
  tier?: CommandTier;
};

export function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition {
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
    category: command.category,
    tier: command.tier,
  };
}

export function registerAlias(
  commands: ChatCommandDefinition[],
  key: string,
  ...aliases: string[]
): void {
  const command = commands.find((entry) => entry.key === key);
  if (!command) {
    throw new Error(`registerAlias: unknown command key: ${key}`);
  }
  const existing = new Set(
    command.textAliases
      .map((alias) => normalizeOptionalLowercaseString(alias))
      .filter((alias): alias is string => Boolean(alias)),
  );
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = normalizeOptionalLowercaseString(trimmed);
    if (!lowered) {
      continue;
    }
    if (existing.has(lowered)) {
      continue;
    }
    existing.add(lowered);
    command.textAliases.push(trimmed);
  }
}

export function assertCommandRegistry(commands: ChatCommandDefinition[]): void {
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
      const nativeKey = normalizeOptionalLowercaseString(nativeName) ?? "";
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
      const aliasKey = normalizeOptionalLowercaseString(alias) ?? "";
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
  }
}

export function buildBuiltinChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      key: "help",
      nativeName: "help",
      description: "Show available commands.",
      textAlias: "/help",
      category: "status",
      tier: "essential",
    }),
    defineChatCommand({
      key: "commands",
      nativeName: "commands",
      description: "List all slash commands.",
      textAlias: "/commands",
      category: "status",
      tier: "power",
    }),
    defineChatCommand({
      key: "tools",
      nativeName: "tools",
      description: "List available runtime tools.",
      textAlias: "/tools",
      category: "status",
      args: [
        {
          name: "mode",
          description: "compact or verbose",
          type: "string",
          choices: ["compact", "verbose"],
        },
      ],
      argsMenu: "auto",
      tier: "standard",
    }),
    defineChatCommand({
      key: "skill",
      nativeName: "skill",
      description: "Run a skill by name.",
      textAlias: "/skill",
      category: "tools",
      tier: "standard",
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
      category: "status",
      tier: "essential",
    }),
    defineChatCommand({
      key: "diagnostics",
      nativeName: "diagnostics",
      description: "Explain Gateway diagnostics and Codex feedback upload options.",
      textAlias: "/diagnostics",
      acceptsArgs: true,
      category: "status",
      tier: "standard",
      args: [
        {
          name: "note",
          description: "Optional note for Codex feedback upload",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "crestodian",
      description: "Run the Crestodian setup and repair helper.",
      textAlias: "/crestodian",
      acceptsArgs: true,
      scope: "text",
      category: "management",
      tier: "essential",
    }),
    defineChatCommand({
      key: "tasks",
      nativeName: "tasks",
      description: "List background tasks for this session.",
      textAlias: "/tasks",
      category: "status",
      tier: "standard",
    }),
    defineChatCommand({
      key: "allowlist",
      description: "List/add/remove allowlist entries.",
      textAlias: "/allowlist",
      acceptsArgs: true,
      scope: "text",
      category: "management",
      tier: "power",
    }),
    defineChatCommand({
      key: "approve",
      nativeName: "approve",
      description: "Approve or deny exec requests.",
      textAlias: "/approve",
      acceptsArgs: true,
      category: "management",
      tier: "power",
    }),
    defineChatCommand({
      key: "context",
      nativeName: "context",
      description: "Explain how context is built and used.",
      textAlias: "/context",
      acceptsArgs: true,
      category: "status",
      tier: "standard",
    }),
    defineChatCommand({
      key: "btw",
      nativeName: "btw",
      description: "Ask a side question without changing future session context.",
      textAlias: "/btw",
      acceptsArgs: true,
      category: "tools",
      tier: "standard",
    }),
    defineChatCommand({
      key: "export-session",
      nativeName: "export-session",
      description: "Export current session to HTML file with full system prompt.",
      textAliases: ["/export-session", "/export"],
      acceptsArgs: true,
      category: "status",
      tier: "essential",
      args: [
        {
          name: "path",
          description: "Output path (default: workspace)",
          type: "string",
          required: false,
        },
      ],
    }),
    defineChatCommand({
      key: "export-trajectory",
      nativeName: "export-trajectory",
      description: "Export a JSONL trajectory bundle for the active session.",
      textAliases: ["/export-trajectory", "/trajectory"],
      acceptsArgs: true,
      category: "status",
      tier: "essential",
      args: [
        {
          name: "path",
          description: "Output directory (default: workspace)",
          type: "string",
          required: false,
        },
      ],
    }),
    defineChatCommand({
      key: "tts",
      nativeName: "tts",
      description: "Control text-to-speech (TTS).",
      textAlias: "/tts",
      category: "media",
      tier: "standard",
      args: [
        {
          name: "action",
          description: "TTS action",
          type: "string",
          choices: [
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
            { value: "status", label: "Status" },
            { value: "provider", label: "Provider" },
            { value: "limit", label: "Limit" },
            { value: "summary", label: "Summary" },
            { value: "audio", label: "Audio" },
            { value: "help", label: "Help" },
          ],
        },
        {
          name: "value",
          description: "Provider, limit, or text",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: {
        arg: "action",
        title:
          "TTS Actions:\n" +
          "• On – Enable TTS for responses\n" +
          "• Off – Disable TTS\n" +
          "• Status – Show current settings\n" +
          "• Provider – Show or set the voice provider\n" +
          "• Limit – Set max characters for TTS\n" +
          "• Summary – Toggle AI summary for long texts\n" +
          "• Audio – Generate TTS from custom text\n" +
          "• Help – Show usage guide",
      },
    }),
    defineChatCommand({
      key: "whoami",
      nativeName: "whoami",
      description: "Show your sender id.",
      textAlias: "/whoami",
      category: "status",
      tier: "power",
    }),
    defineChatCommand({
      key: "session",
      nativeName: "session",
      description: "Manage session-level settings (for example /session idle).",
      textAlias: "/session",
      category: "session",
      tier: "power",
      args: [
        {
          name: "action",
          description: "idle | max-age",
          type: "string",
          choices: ["idle", "max-age"],
        },
        {
          name: "value",
          description: "Duration (24h, 90m) or off",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "subagents",
      nativeName: "subagents",
      description: "List, kill, log, spawn, or steer subagent runs for this session.",
      textAlias: "/subagents",
      category: "management",
      tier: "standard",
      args: [
        {
          name: "action",
          description: "list | kill | log | info | send | steer | spawn",
          type: "string",
          choices: ["list", "kill", "log", "info", "send", "steer", "spawn"],
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
      key: "acp",
      nativeName: "acp",
      description: "Manage ACP sessions and runtime options.",
      textAlias: "/acp",
      category: "management",
      tier: "power",
      args: [
        {
          name: "action",
          description: "Action to run",
          type: "string",
          preferAutocomplete: true,
          choices: [
            "spawn",
            "cancel",
            "steer",
            "close",
            "sessions",
            "status",
            "set-mode",
            "set",
            "cwd",
            "permissions",
            "timeout",
            "model",
            "reset-options",
            "doctor",
            "install",
            "help",
          ],
        },
        {
          name: "value",
          description: "Action arguments",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "focus",
      nativeName: "focus",
      description:
        "Bind this thread (Discord) or topic/conversation (Telegram) to a session target.",
      textAlias: "/focus",
      category: "management",
      tier: "power",
      args: [
        {
          name: "target",
          description: "Subagent label/index or session key/id/label",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "unfocus",
      nativeName: "unfocus",
      description: "Remove the current thread (Discord) or topic/conversation (Telegram) binding.",
      textAlias: "/unfocus",
      category: "management",
      tier: "power",
    }),
    defineChatCommand({
      key: "agents",
      nativeName: "agents",
      description: "List thread-bound agents for this session.",
      textAlias: "/agents",
      category: "management",
      tier: "standard",
    }),
    defineChatCommand({
      key: "kill",
      nativeName: "kill",
      description: "Kill a running subagent (or all).",
      textAlias: "/kill",
      category: "management",
      tier: "standard",
      args: [
        {
          name: "target",
          description: "Label, run id, index, or all",
          type: "string",
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "steer",
      nativeName: "steer",
      description: "Send guidance to a running subagent.",
      textAlias: "/steer",
      category: "management",
      tier: "standard",
      args: [
        {
          name: "target",
          description: "Label, run id, or index",
          type: "string",
        },
        {
          name: "message",
          description: "Steering message",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "config",
      nativeName: "config",
      description: "Show or set config values.",
      textAlias: "/config",
      category: "management",
      tier: "power",
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
      key: "mcp",
      nativeName: "mcp",
      description: "Show or set OpenClaw MCP servers.",
      textAlias: "/mcp",
      category: "management",
      tier: "power",
      args: [
        {
          name: "action",
          description: "show | get | set | unset",
          type: "string",
          choices: ["show", "get", "set", "unset"],
        },
        {
          name: "path",
          description: "MCP server name",
          type: "string",
        },
        {
          name: "value",
          description: "JSON config for set",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.mcp,
    }),
    defineChatCommand({
      key: "plugins",
      nativeName: "plugins",
      description: "List, show, enable, or disable plugins.",
      textAliases: ["/plugins", "/plugin"],
      category: "management",
      tier: "power",
      args: [
        {
          name: "action",
          description: "list | show | get | enable | disable",
          type: "string",
          choices: ["list", "show", "get", "enable", "disable"],
        },
        {
          name: "path",
          description: "Plugin id or name",
          type: "string",
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.plugins,
    }),
    defineChatCommand({
      key: "debug",
      nativeName: "debug",
      description: "Set runtime debug overrides.",
      textAlias: "/debug",
      category: "management",
      tier: "power",
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
      category: "options",
      tier: "standard",
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
      category: "session",
      tier: "essential",
    }),
    defineChatCommand({
      key: "restart",
      nativeName: "restart",
      description: "Restart OpenClaw.",
      textAlias: "/restart",
      category: "tools",
      tier: "power",
    }),
    defineChatCommand({
      key: "activation",
      nativeName: "activation",
      description: "Set group activation mode.",
      textAlias: "/activation",
      category: "management",
      tier: "power",
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
      category: "management",
      tier: "power",
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
      category: "session",
      tier: "essential",
    }),
    defineChatCommand({
      key: "new",
      nativeName: "new",
      description: "Start a new session.",
      textAlias: "/new",
      acceptsArgs: true,
      category: "session",
      tier: "essential",
    }),
    defineChatCommand({
      key: "compact",
      nativeName: "compact",
      description: "Compact the session context.",
      textAlias: "/compact",
      category: "session",
      tier: "essential",
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
      category: "options",
      tier: "essential",
      args: [
        {
          name: "level",
          description: "Thinking level",
          type: "string",
          choices: ({ provider, model, catalog }) => listThinkingLevels(provider, model, catalog),
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "verbose",
      nativeName: "verbose",
      description: "Toggle verbose mode.",
      textAlias: "/verbose",
      category: "options",
      tier: "standard",
      args: [
        {
          name: "mode",
          description: "on, off, or full",
          type: "string",
          choices: ["on", "off", "full"],
        },
      ],
    }),
    defineChatCommand({
      key: "trace",
      nativeName: "trace",
      description: "Toggle plugin trace lines.",
      textAlias: "/trace",
      category: "options",
      tier: "power",
      args: [
        {
          name: "mode",
          description: "on, off, or raw",
          type: "string",
          choices: ["on", "off", "raw"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "fast",
      nativeName: "fast",
      description: "Toggle fast mode.",
      textAlias: "/fast",
      category: "options",
      tier: "standard",
      args: [
        {
          name: "mode",
          description: "status, on, or off",
          type: "string",
          choices: ["status", "on", "off"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reasoning",
      nativeName: "reasoning",
      description: "Toggle reasoning visibility.",
      textAlias: "/reasoning",
      category: "options",
      tier: "standard",
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
      category: "options",
      tier: "power",
      args: [
        {
          name: "mode",
          description: "on, off, ask, or full",
          type: "string",
          choices: ["on", "off", "ask", "full"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "exec",
      nativeName: "exec",
      description: "Set exec defaults for this session.",
      textAlias: "/exec",
      category: "options",
      tier: "power",
      args: [
        {
          name: "host",
          description: "sandbox, gateway, or node",
          type: "string",
          choices: ["sandbox", "gateway", "node"],
        },
        {
          name: "security",
          description: "deny, allowlist, or full",
          type: "string",
          choices: ["deny", "allowlist", "full"],
        },
        {
          name: "ask",
          description: "off, on-miss, or always",
          type: "string",
          choices: ["off", "on-miss", "always"],
        },
        {
          name: "node",
          description: "Node id or name",
          type: "string",
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.exec,
    }),
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: "Show or set the model.",
      textAlias: "/model",
      category: "options",
      tier: "essential",
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
      description: "List model providers/models.",
      textAlias: "/models",
      tier: "standard",
      argsParsing: "none",
      acceptsArgs: true,
      category: "options",
    }),
    defineChatCommand({
      key: "queue",
      nativeName: "queue",
      description: "Adjust queue settings.",
      textAlias: "/queue",
      category: "options",
      tier: "power",
      args: [
        {
          name: "mode",
          description: "queue mode",
          type: "string",
          choices: ["steer", "queue", "interrupt", "followup", "collect", "steer-backlog"],
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
      category: "tools",
      tier: "power",
      args: [
        {
          name: "command",
          description: "Shell command",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
  ];

  registerAlias(commands, "whoami", "/id");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");
  registerAlias(commands, "steer", "/tell");
  assertCommandRegistry(commands);
  return commands;
}
