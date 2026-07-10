// Defines TUI slash commands and their help metadata.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { CommandEntry } from "../../packages/gateway-protocol/src/index.js";
import {
  listChatCommands,
  listChatCommandsForConfig,
  resolveTextCommand,
} from "../auto-reply/commands-registry.js";
import { formatThinkingLevels, listThinkingLevelLabels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.js";

const VERBOSE_LEVELS = ["on", "off"];
const TRACE_LEVELS = ["on", "off"];
const FAST_LEVELS = ["status", "auto", "on", "off"];
const REASONING_LEVELS = ["on", "off"];
const ELEVATED_LEVELS = ["on", "off", "ask", "full"];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_FOOTER_LEVELS = ["off", "tokens", "full", "reset", "inherit", "clear", "default"];

export type ParsedCommand = {
  name: string;
  args: string;
};

export type SlashCommandOptions = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevels?: Array<{ id: string; label: string }>;
  local?: boolean;
  dynamicCommands?: CommandEntry[];
};

const COMMAND_ALIASES: Record<string, string> = {
  gwstatus: "gateway-status",
};

// These shared commands have explicit local TUI routing but no same-named
// built-in autocomplete entry. Other shared commands require the Gateway and
// must stay out of local autocomplete and model prompts.
const LOCAL_TUI_ROUTED_SHARED_COMMANDS = new Set(["btw", "goal", "stop"]);

function createLevelCompletion(
  levels: string[],
): NonNullable<SlashCommand["getArgumentCompletions"]> {
  return (prefix) =>
    levels
      .filter((value) => value.startsWith(normalizeLowercaseStringOrEmpty(prefix)))
      .map((value) => ({
        value,
        label: value,
      }));
}

function normalizeSlashCommandName(value: string): string {
  return value.replace(/^\//, "").trim();
}

function appendSlashCommand(
  commands: SlashCommand[],
  seen: Set<string>,
  name: string,
  description: string,
) {
  const normalizedName = normalizeSlashCommandName(name);
  if (!normalizedName || seen.has(normalizedName)) {
    return;
  }
  seen.add(normalizedName);
  commands.push({ name: normalizedName, description });
}

export function parseCommand(input: string): ParsedCommand {
  const sharedCommand = resolveTextCommand(input);
  if (sharedCommand) {
    return {
      name: sharedCommand.command.key,
      args: sharedCommand.args ?? "",
    };
  }
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) {
    return { name: "", args: "" };
  }
  const [name, ...rest] = trimmed.split(/\s+/);
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return {
    name: COMMAND_ALIASES[normalized] ?? normalized,
    args: rest.join(" ").trim(),
  };
}

/** Whether a slash input belongs to the shared Gateway command registry. */
export function isSharedTextCommand(input: string): boolean {
  return resolveTextCommand(input) !== null;
}

export function getSlashCommands(options: SlashCommandOptions = {}): SlashCommand[] {
  const thinkLevels = options.thinkingLevels?.length
    ? options.thinkingLevels.map((level) => level.label)
    : listThinkingLevelLabels(options.provider, options.model, undefined, options.agentRuntime);
  const verboseCompletions = createLevelCompletion(VERBOSE_LEVELS);
  const traceCompletions = createLevelCompletion(TRACE_LEVELS);
  const fastCompletions = createLevelCompletion(FAST_LEVELS);
  const reasoningCompletions = createLevelCompletion(REASONING_LEVELS);
  const usageCompletions = createLevelCompletion(USAGE_FOOTER_LEVELS);
  const elevatedCompletions = createLevelCompletion(ELEVATED_LEVELS);
  const activationCompletions = createLevelCompletion(ACTIVATION_LEVELS);
  const commands: SlashCommand[] = [
    { name: "help", description: "Show slash command help" },
    { name: "gateway-status", description: "Show gateway status summary" },
    { name: "gwstatus", description: "Alias for /gateway-status" },
    ...(options.local ? [{ name: "auth", description: "Run provider auth/login flow" }] : []),
    { name: "agent", description: "Switch agent (or open picker)" },
    { name: "agents", description: "Open agent picker" },
    { name: "crestodian", description: "Return to Crestodian" },
    { name: "session", description: "Switch session (or open picker)" },
    { name: "sessions", description: "Open session picker" },
    {
      name: "model",
      description: "Set model (or open picker)",
    },
    { name: "models", description: "Open model picker" },
    {
      name: "think",
      description: "Set thinking level",
      getArgumentCompletions: (prefix) =>
        thinkLevels
          .filter((v) => v.startsWith(normalizeLowercaseStringOrEmpty(prefix)))
          .map((value) => ({ value, label: value })),
    },
    {
      name: "fast",
      description: "Set fast mode auto/on/off",
      getArgumentCompletions: fastCompletions,
    },
    {
      name: "verbose",
      description: "Set verbose on/off",
      getArgumentCompletions: verboseCompletions,
    },
    {
      name: "trace",
      description: "Set trace on/off",
      getArgumentCompletions: traceCompletions,
    },
    {
      name: "reasoning",
      description: "Set reasoning on/off",
      getArgumentCompletions: reasoningCompletions,
    },
    {
      name: "usage",
      description: "Toggle per-response usage line",
      getArgumentCompletions: usageCompletions,
    },
    {
      name: "elevated",
      description: "Set elevated on/off/ask/full",
      getArgumentCompletions: elevatedCompletions,
    },
    {
      name: "elev",
      description: "Alias for /elevated",
      getArgumentCompletions: elevatedCompletions,
    },
    {
      name: "activation",
      description: "Set group activation",
      getArgumentCompletions: activationCompletions,
    },
    { name: "abort", description: "Abort active run" },
    { name: "new", description: "Spawn a new isolated session" },
    { name: "reset", description: "Reset the current session" },
    { name: "settings", description: "Open settings" },
    { name: "exit", description: "Exit the TUI" },
    { name: "quit", description: "Exit the TUI" },
  ];

  const seen = new Set(commands.map((command) => command.name));
  const gatewayCommands = options.cfg ? listChatCommandsForConfig(options.cfg) : listChatCommands();
  for (const command of gatewayCommands) {
    if (
      options.local &&
      !seen.has(command.key) &&
      !LOCAL_TUI_ROUTED_SHARED_COMMANDS.has(command.key)
    ) {
      continue;
    }
    const aliases = command.textAliases.length > 0 ? command.textAliases : [`/${command.key}`];
    for (const alias of aliases) {
      appendSlashCommand(commands, seen, alias, command.description);
    }
  }

  for (const command of options.dynamicCommands ?? []) {
    const aliases = command.textAliases?.length ? command.textAliases : [command.name];
    for (const alias of aliases) {
      appendSlashCommand(commands, seen, alias, command.description);
    }
  }

  return commands;
}

export function helpText(options: SlashCommandOptions = {}): string {
  const thinkLevels = formatThinkingLevels(
    options.provider,
    options.model,
    "|",
    undefined,
    options.agentRuntime,
  );
  return [
    "Slash commands:",
    "/help",
    ...(options.local ? [] : ["/commands", "/status"]),
    "/gateway-status",
    "/gwstatus",
    ...(options.local ? ["/auth [provider]"] : []),
    "/agent <id> (or /agents)",
    "/crestodian [request]",
    "/session <key> (or /sessions)",
    "/model <provider/model> (or /models)",
    `/think <${thinkLevels}>`,
    "/fast <status|auto|on|off>",
    "/verbose <on|off>",
    "/trace <on|off>",
    "/reasoning <on|off>",
    "/usage <off|tokens|full|reset|inherit|clear|default>",
    "/elevated <on|off|ask|full>",
    "/elev <on|off|ask|full>",
    "/activation <mention|always>",
    "/new or /reset",
    "/abort",
    "/settings",
    "/exit",
  ].join("\n");
}
