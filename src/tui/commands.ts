import type { SlashCommand } from "@mariozechner/pi-tui";
import { listChatCommands, listChatCommandsForConfig } from "../auto-reply/commands-registry.js";
import { formatThinkingLevels, listThinkingLevelLabels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const VERBOSE_LEVELS = ["on", "off"];
const TRACE_LEVELS = ["on", "off"];
const FAST_LEVELS = ["status", "on", "off"];
const REASONING_LEVELS = ["on", "off"];
const ELEVATED_LEVELS = ["on", "off", "ask", "full"];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_FOOTER_LEVELS = ["off", "tokens", "full"];

export type ParsedCommand = {
  name: string;
  args: string;
};

export type SlashCommandOptions = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  local?: boolean;
};

const COMMAND_ALIASES: Record<string, string> = {
  elev: "elevated",
  gwstatus: "gateway-status",
};

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

export function parseCommand(input: string): ParsedCommand {
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

export function getSlashCommands(options: SlashCommandOptions = {}): SlashCommand[] {
  const thinkLevels = listThinkingLevelLabels(options.provider, options.model);
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
      description: "Set fast mode on/off",
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
    { name: "new", description: "Reset the session" },
    { name: "reset", description: "Reset the session" },
    { name: "settings", description: "Open settings" },
    { name: "exit", description: "Exit the TUI" },
    { name: "quit", description: "Exit the TUI" },
  ];

  const seen = new Set(commands.map((command) => command.name));
  const gatewayCommands = options.cfg ? listChatCommandsForConfig(options.cfg) : listChatCommands();
  for (const command of gatewayCommands) {
    const aliases = command.textAliases.length > 0 ? command.textAliases : [`/${command.key}`];
    for (const alias of aliases) {
      const name = alias.replace(/^\//, "").trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      commands.push({ name, description: command.description });
    }
  }

  return commands;
}

export function helpText(options: SlashCommandOptions = {}): string {
  const thinkLevels = formatThinkingLevels(options.provider, options.model, "|");
  return [
    "Slash commands:",
    "/help",
    "/commands",
    "/status",
    "/gateway-status",
    "/gwstatus",
    ...(options.local ? ["/auth [provider]"] : []),
    "/agent <id> (or /agents)",
    "/session <key> (or /sessions)",
    "/model <provider/model> (or /models)",
    `/think <${thinkLevels}>`,
    "/fast <status|on|off>",
    "/verbose <on|off>",
    "/trace <on|off>",
    "/reasoning <on|off>",
    "/usage <off|tokens|full>",
    "/elevated <on|off|ask|full>",
    "/elev <on|off|ask|full>",
    "/activation <mention|always>",
    "/new or /reset",
    "/abort",
    "/settings",
    "/exit",
  ].join("\n");
}
