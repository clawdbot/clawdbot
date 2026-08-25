// Defines TUI slash commands and their help metadata.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { CommandEntry } from "../../packages/gateway-protocol/src/index.js";
import {
  listChatCommands,
  listChatCommandsForConfig,
  resolveTextCommand,
} from "../auto-reply/commands-registry.js";
import {
  formatThinkingLevels,
  listThinkingLevelLabels,
  type ReasoningLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.js";

const VERBOSE_LEVELS = ["on", "off", "full"] satisfies VerboseLevel[];
const TRACE_LEVELS = ["on", "off"];
const FAST_LEVELS = ["status", "auto", "on", "off", "default"];
const REASONING_LEVELS = ["on", "off", "stream"] satisfies ReasoningLevel[];
const ELEVATED_LEVELS = ["on", "off", "ask", "full"];
const ACTIVATION_LEVELS = ["mention", "always"];
const USAGE_COMMAND_VALUES = [
  "off",
  "tokens",
  "full",
  "cost",
  "reset",
  "inherit",
  "clear",
  "default",
];

type ParsedCommand = {
  name: string;
  args: string;
};

type SlashCommandOptions = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevels?: Array<{ id: string; label: string }>;
  local?: boolean;
  dynamicCommands?: CommandEntry[];
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

/** Keep TUI help and no-argument usage aligned with actual directive completions. */
export function formatTuiLevelCommandUsage(command: "verbose" | "reasoning"): string {
  const levels = command === "verbose" ? VERBOSE_LEVELS : REASONING_LEVELS;
  return `/${command} <${levels.join("|")}>`;
}

type TuiCommandDescriptor = {
  name: string;
  description?: string;
  aliases?: readonly { name: string; description?: string; hidden?: boolean }[];
  scope?: "both" | "local" | "remote";
  shared?: boolean;
  handler?: true;
  help?: string | readonly string[];
  completions?: readonly string[] | "thinking";
};

type TuiCommandRow = readonly [
  name: string,
  description?: string,
  help?: string | readonly string[],
  completions?: readonly string[] | "thinking",
  options?: Pick<TuiCommandDescriptor, "aliases" | "scope" | "shared"> & { handler?: false },
];

const TUI_COMMAND_ROWS = [
  ["help", "Show slash command help", "/help"],
  [
    "commands",
    undefined,
    "/commands",
    undefined,
    { scope: "remote", shared: true, handler: false },
  ],
  ["status", undefined, "/status", undefined, { scope: "remote", shared: true, handler: false }],
  [
    "gateway-status",
    "Show gateway status summary",
    ["/gateway-status", "/gwstatus"],
    undefined,
    { aliases: [{ name: "gwstatus", description: "Alias for /gateway-status" }] },
  ],
  ["auth", "Run provider auth/login flow", "/auth [provider]", undefined, { scope: "local" }],
  ["agent", "Switch agent (or open picker)", "/agent <id> (or /agents)"],
  ["agents", "Open agent picker"],
  [
    "openclaw",
    "Return to OpenClaw",
    "/openclaw [request]",
    undefined,
    { aliases: [{ name: "crestodian", hidden: true }] },
  ],
  ["session", "Switch session (or open picker)", "/session <key> (or /sessions)"],
  ["sessions", "Open session picker"],
  ["model", "Set model (or open picker)", "/model <provider/model|default> (or /models)"],
  ["models", "Open model picker"],
  ["think", "Set thinking level", "/think <{thinkingLevels}|default>", "thinking"],
  ["fast", "Set fast mode auto/on/off", "/fast <status|auto|on|off|default>", FAST_LEVELS],
  [
    "verbose",
    `Set verbose ${VERBOSE_LEVELS.join("/")}`,
    formatTuiLevelCommandUsage("verbose"),
    VERBOSE_LEVELS,
  ],
  ["trace", "Set trace on/off", "/trace <on|off>", TRACE_LEVELS],
  [
    "reasoning",
    `Set reasoning ${REASONING_LEVELS.join("/")}`,
    formatTuiLevelCommandUsage("reasoning"),
    REASONING_LEVELS,
  ],
  [
    "usage",
    "Toggle per-response usage line or show cost summary",
    "/usage <off|tokens|full|cost|reset|inherit|clear|default>",
    USAGE_COMMAND_VALUES,
  ],
  [
    "elevated",
    "Set elevated on/off/ask/full",
    ["/elevated <on|off|ask|full>", "/elev <on|off|ask|full>"],
    ELEVATED_LEVELS,
    { aliases: [{ name: "elev", description: "Alias for /elevated" }] },
  ],
  ["activation", "Set group activation", "/activation <mention|always>", ACTIVATION_LEVELS],
  ["context", undefined, undefined, undefined, { scope: "remote", shared: true }],
  [
    "goal",
    undefined,
    "/goal <objective> | /goal [status] | /goal start <objective> | /goal edit <objective> | /goal pause|resume|complete|block|clear",
    undefined,
    { shared: true },
  ],
  ["btw", undefined, "/btw <side question>", undefined, { shared: true }],
  ["queue", undefined, "/queue [mode]", undefined, { shared: true }],
  ["stop", undefined, "/stop", undefined, { shared: true }],
  ["new", "Spawn a new isolated session", "/new or /reset"],
  ["reset", "Reset the current session"],
  ["abort", "Abort active run", "/abort"],
  ["settings", "Open settings", "/settings"],
  [
    "exit",
    "Exit the TUI",
    "/exit",
    undefined,
    { aliases: [{ name: "quit", description: "Exit the TUI" }] },
  ],
] as const satisfies readonly TuiCommandRow[];

const TUI_COMMAND_ROW_VALUES: readonly TuiCommandRow[] = TUI_COMMAND_ROWS;
const TUI_COMMAND_DESCRIPTORS: readonly TuiCommandDescriptor[] = TUI_COMMAND_ROW_VALUES.map(
  ([name, description, help, completions, options]) => {
    const descriptor: TuiCommandDescriptor = { name, description, help, completions };
    descriptor.aliases = options?.aliases;
    descriptor.scope = options?.scope;
    descriptor.shared = options?.shared;
    if (options?.handler !== false) {
      descriptor.handler = true;
    }
    return descriptor;
  },
);

export type TuiCommandHandlerName = Exclude<
  (typeof TUI_COMMAND_ROWS)[number][0],
  "commands" | "status"
>;

export function resolveTuiCommandDescriptor(name: string): TuiCommandDescriptor | undefined {
  return TUI_COMMAND_DESCRIPTORS.find(
    (command) => command.name === name || command.aliases?.some((alias) => alias.name === name),
  );
}

function commandIsVisible(command: TuiCommandDescriptor, local: boolean): boolean {
  return command.scope !== (local ? "remote" : "local");
}

function normalizeSlashCommandName(value: string): string {
  return value.replace(/^\//, "").trim();
}

function appendSlashCommand(
  commands: SlashCommand[],
  seen: Map<string, SlashCommand["getArgumentCompletions"]>,
  name: string,
  description: string,
  getArgumentCompletions?: SlashCommand["getArgumentCompletions"],
) {
  const normalizedName = normalizeSlashCommandName(name);
  if (!normalizedName || seen.has(normalizedName)) {
    return;
  }
  seen.set(normalizedName, getArgumentCompletions);
  commands.push({ name: normalizedName, description, getArgumentCompletions });
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
  const descriptor = resolveTuiCommandDescriptor(normalized);
  return {
    name: descriptor?.name ?? normalized,
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
  const commands: SlashCommand[] = [];
  const seen = new Map<string, SlashCommand["getArgumentCompletions"]>();
  for (const command of TUI_COMMAND_DESCRIPTORS) {
    if (
      command.shared ||
      !command.description ||
      !commandIsVisible(command, options.local === true)
    ) {
      continue;
    }
    const completions =
      command.completions === "thinking"
        ? createLevelCompletion([...thinkLevels, "default"])
        : command.completions
          ? createLevelCompletion([...command.completions])
          : undefined;
    appendSlashCommand(commands, seen, command.name, command.description, completions);
    for (const alias of command.aliases ?? []) {
      if (!alias.hidden) {
        appendSlashCommand(
          commands,
          seen,
          alias.name,
          alias.description ?? command.description,
          completions,
        );
      }
    }
  }

  const gatewayCommands = options.cfg ? listChatCommandsForConfig(options.cfg) : listChatCommands();
  for (const command of gatewayCommands) {
    const descriptor = resolveTuiCommandDescriptor(command.key);
    if (options.local && !seen.has(command.key) && !descriptor?.shared) {
      continue;
    }
    if (options.local && descriptor && !commandIsVisible(descriptor, true)) {
      continue;
    }
    const aliases = command.textAliases.length > 0 ? command.textAliases : [`/${command.key}`];
    for (const alias of aliases) {
      appendSlashCommand(commands, seen, alias, command.description, seen.get(command.key));
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

export function shouldSubmitExactArgumentCompletion(
  input: string,
  commands: SlashCommand[],
): boolean {
  const match = /^\/([^\s]+)\s+(.+)$/u.exec(input);
  if (!match) {
    return false;
  }
  const [, commandName, argumentText] = match;
  if (argumentText === undefined) {
    return false;
  }
  const command = commands.find((candidate) => candidate.name === commandName);
  if (!command?.getArgumentCompletions) {
    return false;
  }
  const completions = command.getArgumentCompletions(argumentText);
  return (
    Array.isArray(completions) && completions.length === 1 && completions[0]?.value === argumentText
  );
}

export function helpText(options: SlashCommandOptions = {}): string {
  const thinkLevels = formatThinkingLevels(
    options.provider,
    options.model,
    "|",
    undefined,
    options.agentRuntime,
  );
  const commandHelp = TUI_COMMAND_DESCRIPTORS.flatMap((command) => {
    if (!command.help || !commandIsVisible(command, options.local === true)) {
      return [];
    }
    const lines = typeof command.help === "string" ? [command.help] : command.help;
    return lines.map((line) => line.replace("{thinkingLevels}", thinkLevels));
  });
  return [
    "Slash commands:",
    ...commandHelp,
    "",
    "Keyboard shortcuts:",
    "Enter: send message",
    "Shift+Enter or Ctrl+J: insert a newline",
  ].join("\n");
}
