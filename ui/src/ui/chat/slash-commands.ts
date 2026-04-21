import { buildBuiltinChatCommands } from "../../../../src/auto-reply/commands-registry.shared.js";
import type { CommandEntry, CommandsListResult } from "../../../../src/gateway/protocol/index.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { IconName } from "../icons.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

export type SlashCommandCategory = "session" | "model" | "agents" | "tools";

export type SlashCommandTier = "essential" | "standard" | "power";

export type SlashCommandDef = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  icon?: IconName;
  category?: SlashCommandCategory;
  /** When true, the command is executed client-side via RPC instead of sent to the agent. */
  executeLocal?: boolean;
  /** Fixed argument choices for inline hints. */
  argOptions?: string[];
  /** Keyboard shortcut hint shown in the menu (display only). */
  shortcut?: string;
  /** Progressive disclosure tier. Defaults to "standard" when omitted. */
  tier?: SlashCommandTier;
};

type LocalArgChoice = string | { value: string; label: string };

type CommandLike = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  args?: Array<{
    name: string;
    required?: boolean;
    choices?: LocalArgChoice[];
  }>;
  category?: string;
  tier?: string;
};

const REMOTE_SLASH_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const MAX_REMOTE_COMMANDS = 500;
const MAX_REMOTE_ALIAS_COUNT = 20;
const MAX_REMOTE_ARGS = 20;
const MAX_REMOTE_CHOICES = 50;
const MAX_REMOTE_NAME_LENGTH = 200;
const MAX_REMOTE_DESCRIPTION_LENGTH = 2_000;
const MAX_REMOTE_ARG_NAME_LENGTH = 200;

const COMMAND_ICON_OVERRIDES: Partial<Record<string, IconName>> = {
  help: "book",
  status: "barChart",
  usage: "barChart",
  export: "download",
  export_session: "download",
  tools: "terminal",
  skill: "zap",
  commands: "book",
  new: "plus",
  reset: "refresh",
  compact: "loader",
  stop: "stop",
  clear: "trash",
  focus: "eye",
  unfocus: "eye",
  model: "brain",
  models: "brain",
  think: "brain",
  verbose: "terminal",
  fast: "zap",
  agents: "monitor",
  subagents: "folder",
  kill: "x",
  steer: "send",
  tts: "volume2",
};

const LOCAL_COMMANDS = new Set([
  "help",
  "new",
  "reset",
  "stop",
  "compact",
  "focus",
  "model",
  "think",
  "fast",
  "verbose",
  "export-session",
  "usage",
  "agents",
  "kill",
  "steer",
  "redirect",
]);

const UI_ONLY_COMMANDS: SlashCommandDef[] = [
  {
    key: "clear",
    name: "clear",
    description: "Clear chat history",
    icon: "trash",
    category: "session",
    executeLocal: true,
    tier: "standard",
  },
  {
    key: "redirect",
    name: "redirect",
    description: "Abort and restart with a new message",
    args: "[id] <message>",
    icon: "refresh",
    category: "agents",
    executeLocal: true,
    tier: "power",
  },
];

const CATEGORY_OVERRIDES: Partial<Record<string, SlashCommandCategory>> = {
  help: "tools",
  commands: "tools",
  tools: "tools",
  skill: "tools",
  status: "tools",
  export_session: "tools",
  usage: "tools",
  tts: "tools",
  agents: "agents",
  subagents: "agents",
  kill: "agents",
  steer: "agents",
  redirect: "agents",
  session: "session",
  stop: "session",
  reset: "session",
  new: "session",
  compact: "session",
  focus: "session",
  unfocus: "session",
  model: "model",
  models: "model",
  think: "model",
  verbose: "model",
  fast: "model",
  reasoning: "model",
  elevated: "model",
  queue: "model",
};

const COMMAND_DESCRIPTION_OVERRIDES: Partial<Record<string, string>> = {
  steer: "Inject a message into the active run",
};

const COMMAND_ARGS_OVERRIDES: Partial<Record<string, string>> = {
  steer: "[id] <message>",
};

function normalizeUiKey(command: CommandLike): string {
  return command.key.replace(/[:.-]/g, "_");
}

function getSlashAliases(command: CommandLike): string[] {
  return (command.aliases ?? [])
    .map((alias) => alias.trim())
    .filter(Boolean)
    .map((alias) => (alias.startsWith("/") ? alias.slice(1) : alias));
}

function getPrimarySlashName(command: CommandLike): string | null {
  return command.name.trim() || null;
}

function formatArgs(command: CommandLike): string | undefined {
  if (!command.args?.length) {
    return undefined;
  }
  return command.args
    .map((arg) => {
      const token = `<${arg.name}>`;
      return arg.required ? token : `[${arg.name}]`;
    })
    .join(" ");
}

function choiceToValue(choice: LocalArgChoice): string {
  return typeof choice === "string" ? choice : choice.value;
}

function getArgOptions(command: CommandLike): string[] | undefined {
  const firstArg = command.args?.[0];
  if (!firstArg) {
    return undefined;
  }
  const options = firstArg.choices?.map(choiceToValue).filter(Boolean);
  return options?.length ? options : undefined;
}

function mapCategory(command: CommandLike): SlashCommandCategory {
  const override = CATEGORY_OVERRIDES[normalizeUiKey(command)];
  if (override) {
    return override;
  }
  switch (command.category) {
    case "session":
      return "session";
    case "options":
      return "model";
    case "management":
      return "tools";
    default:
      return "tools";
  }
}

function mapIcon(command: CommandLike): IconName | undefined {
  return COMMAND_ICON_OVERRIDES[normalizeUiKey(command)] ?? "terminal";
}

function mapTier(command: CommandLike): SlashCommandTier {
  const raw = command.tier;
  if (raw === "essential" || raw === "standard" || raw === "power") {
    return raw;
  }
  return "standard";
}

function toSlashCommand(
  command: CommandLike,
  source: "local" | "remote" = "local",
): SlashCommandDef | null {
  const name = getPrimarySlashName(command);
  if (!name) {
    return null;
  }
  return {
    key: command.key,
    name,
    aliases: getSlashAliases(command).filter((alias) => alias !== name),
    description: COMMAND_DESCRIPTION_OVERRIDES[command.key] ?? command.description,
    args: COMMAND_ARGS_OVERRIDES[command.key] ?? formatArgs(command),
    icon: mapIcon(command),
    category: mapCategory(command),
    executeLocal: source === "local" && LOCAL_COMMANDS.has(command.key),
    argOptions: getArgOptions(command),
    tier: source === "local" ? mapTier(command) : "standard",
  };
}

function normalizeSlashIdentifier(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\//u, "").slice(0, MAX_REMOTE_NAME_LENGTH);
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (!normalized || !REMOTE_SLASH_IDENTIFIER_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function clampText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getEntryArgs(
  entry: CommandEntry | Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rawArgs = "args" in entry ? entry.args : undefined;
  if (!Array.isArray(rawArgs)) {
    return [];
  }
  return rawArgs
    .map((arg) => asRecord(arg))
    .filter((arg): arg is Record<string, unknown> => arg !== null);
}

function getArgChoices(arg: Record<string, unknown>): LocalArgChoice[] {
  if (arg.dynamic === true) {
    return [];
  }
  const rawChoices = arg.choices;
  if (!Array.isArray(rawChoices)) {
    return [];
  }
  return rawChoices
    .map((choice) => {
      if (typeof choice === "string") {
        return clampText(choice, MAX_REMOTE_NAME_LENGTH);
      }
      const record = asRecord(choice);
      if (!record) {
        return null;
      }
      return {
        value: clampText(record.value, MAX_REMOTE_NAME_LENGTH),
        label: clampText(record.label, MAX_REMOTE_NAME_LENGTH),
      };
    })
    .filter((choice): choice is LocalArgChoice => {
      if (!choice) {
        return false;
      }
      return typeof choice === "string" ? Boolean(choice) : Boolean(choice.value);
    });
}

function buildLocalSlashCommands(): SlashCommandDef[] {
  const builtins = buildBuiltinChatCommands()
    .map((command) => ({
      key: command.key,
      name: command.textAliases[0]?.replace(/^\//u, "") ?? command.key,
      aliases: command.textAliases,
      description: command.description,
      args: command.args?.map((arg) => ({
        name: arg.name,
        required: arg.required,
        choices: Array.isArray(arg.choices) ? arg.choices : undefined,
      })),
      category: command.category,
      tier: command.tier,
    }))
    .map((command) => toSlashCommand(command, "local"))
    .filter((command): command is SlashCommandDef => command !== null);
  return [...builtins, ...UI_ONLY_COMMANDS];
}

function buildReservedLocalSlashNames(localCommands = buildLocalSlashCommands()): Set<string> {
  const reserved = new Set<string>();
  for (const command of localCommands) {
    reserved.add(normalizeLowercaseStringOrEmpty(command.name));
    for (const alias of command.aliases ?? []) {
      const normalized = normalizeSlashIdentifier(alias);
      if (normalized) {
        reserved.add(normalized);
      }
    }
  }
  return reserved;
}

function normalizeCommandEntry(
  entry: CommandEntry | Record<string, unknown>,
  reservedLocalNames: Set<string>,
): CommandLike | null {
  const aliases = (Array.isArray(entry.textAliases) ? entry.textAliases : [])
    .slice(0, MAX_REMOTE_ALIAS_COUNT)
    .filter((alias): alias is string => typeof alias === "string")
    .map(normalizeSlashIdentifier)
    .filter((alias): alias is string => Boolean(alias))
    .filter((alias) => !reservedLocalNames.has(alias));
  const primaryName =
    aliases[0] ?? (typeof entry.name === "string" ? normalizeSlashIdentifier(entry.name) : null);
  if (!primaryName || reservedLocalNames.has(primaryName)) {
    return null;
  }
  const args = getEntryArgs(entry)
    .slice(0, MAX_REMOTE_ARGS)
    .map((arg) => ({
      name: clampText(arg.name, MAX_REMOTE_ARG_NAME_LENGTH),
      required: arg.required === true,
      choices: getArgChoices(arg).slice(0, MAX_REMOTE_CHOICES),
    }))
    .filter((arg) => arg.name.length > 0)
    .map((arg) =>
      Object.assign(
        { name: arg.name },
        arg.required ? { required: true } : {},
        arg.choices.length > 0 ? { choices: arg.choices } : {},
      ),
    );
  return {
    key: primaryName,
    name: primaryName,
    aliases: aliases.map((alias) => `/${alias}`),
    description: clampText(entry.description, MAX_REMOTE_DESCRIPTION_LENGTH),
    ...(args.length > 0 ? { args } : {}),
    category: typeof entry.category === "string" ? entry.category : undefined,
  };
}

function replaceSlashCommands(next: SlashCommandDef[]) {
  SLASH_COMMANDS.splice(0, SLASH_COMMANDS.length, ...next);
}

function buildSlashCommandsFromEntries(entries: CommandEntry[]): SlashCommandDef[] {
  const local = buildLocalSlashCommands();
  const reservedLocalNames = buildReservedLocalSlashNames(local);
  const mapped = entries
    .slice(0, MAX_REMOTE_COMMANDS)
    .map((entry) => normalizeCommandEntry(entry, reservedLocalNames))
    .filter((command): command is CommandLike => command !== null)
    .map((command) => toSlashCommand(command, "remote"))
    .filter((command): command is SlashCommandDef => command !== null);
  const deduped = new Map<string, SlashCommandDef>();
  for (const command of [...local, ...mapped]) {
    const key = normalizeLowercaseStringOrEmpty(command.name);
    if (!key || deduped.has(key)) {
      continue;
    }
    deduped.set(key, command);
  }
  return Array.from(deduped.values());
}

function getRemoteCommandEntries(result: CommandsListResult | null | undefined): CommandEntry[] {
  const commands = result?.commands;
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands
    .map((entry) => asRecord(entry))
    .filter((entry): entry is CommandEntry => entry !== null);
}

function buildFallbackSlashCommands(): SlashCommandDef[] {
  return buildLocalSlashCommands();
}

export const SLASH_COMMANDS: SlashCommandDef[] = buildFallbackSlashCommands();

let _refreshSeq = 0;

export async function refreshSlashCommands(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
}): Promise<void> {
  const seq = ++_refreshSeq;
  const agentId = params.agentId?.trim();
  if (!params.client) {
    if (seq !== _refreshSeq) {
      return;
    }
    replaceSlashCommands(buildFallbackSlashCommands());
    return;
  }
  try {
    const result = await params.client.request<CommandsListResult>("commands.list", {
      ...(agentId ? { agentId } : {}),
      includeArgs: true,
      scope: "text",
    });
    if (seq !== _refreshSeq) {
      return;
    }
    replaceSlashCommands(buildSlashCommandsFromEntries(getRemoteCommandEntries(result)));
  } catch {
    if (seq !== _refreshSeq) {
      return;
    }
    replaceSlashCommands(buildFallbackSlashCommands());
  }
}

export function resetSlashCommandsForTest(): void {
  _refreshSeq = 0;
  replaceSlashCommands(buildFallbackSlashCommands());
}

const CATEGORY_ORDER: SlashCommandCategory[] = ["session", "model", "tools", "agents"];

export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  session: "Session",
  model: "Model",
  agents: "Agents",
  tools: "Tools",
};

const TIER_ORDER: Record<SlashCommandTier, number> = {
  essential: 0,
  standard: 1,
  power: 2,
};

export function getSlashCommandCompletions(
  filter: string,
  options?: { showAll?: boolean },
): SlashCommandDef[] {
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const showAll = options?.showAll ?? false;
  let commands = lower
    ? SLASH_COMMANDS.filter(
        (cmd) =>
          cmd.name.startsWith(lower) ||
          cmd.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias).startsWith(lower)) ||
          normalizeLowercaseStringOrEmpty(cmd.description).includes(lower),
      )
    : SLASH_COMMANDS;

  // When no filter text and not explicitly showing all, hide "power" tier commands
  if (!lower && !showAll) {
    commands = commands.filter((cmd) => (cmd.tier ?? "standard") !== "power");
  }

  return commands.toSorted((a, b) => {
    // Sort by tier first (essential → standard → power)
    const aTier = TIER_ORDER[a.tier ?? "standard"] ?? 1;
    const bTier = TIER_ORDER[b.tier ?? "standard"] ?? 1;
    if (aTier !== bTier) {
      return aTier - bTier;
    }
    const ai = CATEGORY_ORDER.indexOf(a.category ?? "session");
    const bi = CATEGORY_ORDER.indexOf(b.category ?? "session");
    if (ai !== bi) {
      return ai - bi;
    }
    if (lower) {
      const aExact = a.name.startsWith(lower) ? 0 : 1;
      const bExact = b.name.startsWith(lower) ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
    }
    return 0;
  });
}

/** Count of commands hidden by tier filtering (for "Show N more" UI). */
export function getHiddenCommandCount(): number {
  return SLASH_COMMANDS.filter((cmd) => (cmd.tier ?? "standard") === "power").length;
}

export type ParsedSlashCommand = {
  command: SlashCommandDef;
  args: string;
};

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1);
  const firstSeparator = body.search(/[\s:]/u);
  const name = firstSeparator === -1 ? body : body.slice(0, firstSeparator);
  let remainder = firstSeparator === -1 ? "" : body.slice(firstSeparator).trimStart();
  if (remainder.startsWith(":")) {
    remainder = remainder.slice(1).trimStart();
  }
  const args = remainder.trim();

  if (!name) {
    return null;
  }

  const normalizedName = normalizeLowercaseStringOrEmpty(name);
  const command = SLASH_COMMANDS.find(
    (cmd) =>
      cmd.name === normalizedName ||
      cmd.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalizedName),
  );
  if (!command) {
    return null;
  }

  return { command, args };
}
