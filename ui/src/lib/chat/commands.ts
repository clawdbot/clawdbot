// Control UI chat domain owns pure slash command rules.

import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CommandEntry } from "../../../../packages/gateway-protocol/src/index.js";
import type { CommandArgValues } from "../../../../src/auto-reply/commands-args.types.js";
import { buildBuiltinChatCommands } from "../../../../src/auto-reply/commands-registry.shared.js";
import type { IconName } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export type SlashCommandCategory = "session" | "model" | "agents" | "tools";

type SlashCommandTier = "essential" | "standard" | "power";

export type SlashCommandDef = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  descriptionKey?: string;
  args?: string;
  icon?: IconName;
  category?: SlashCommandCategory;
  /** When true, the command is executed client-side via RPC instead of sent to the agent. */
  executeLocal?: boolean;
  /** Fixed argument choices for inline hints. */
  argOptions?: string[];
  /** Whether a multi-word argument may execute from an inline prose position. */
  allowsInlineMultiWordArgs?: boolean;
  /** Keyboard shortcut hint shown in the menu (display only). */
  shortcut?: string;
  /** Progressive disclosure tier. Defaults to "standard" when omitted. */
  tier?: SlashCommandTier;
  source?: "native" | "plugin" | "skill";
  skillDisplayName?: string;
  skillModelVisible?: boolean;
  clientPresentation?: NonNullable<CommandEntry["clientPresentation"]>;
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
  formatArgs?: (values: CommandArgValues) => string | undefined;
  category?: string;
  tier?: string;
  source?: "native" | "plugin" | "skill";
  skillDisplayName?: string;
  skillModelVisible?: boolean;
  clientPresentation?: NonNullable<CommandEntry["clientPresentation"]>;
};

export function executesInlineImmediately(command: SlashCommandDef): boolean {
  return command.source !== "skill";
}

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
  dashboard: "layoutDashboard",
  skill: "zap",
  commands: "book",
  new: "plus",
  reset: "refresh",
  compact: "loader",
  stop: "stop",
  clear: "trash",
  model: "brain",
  models: "brain",
  think: "brain",
  verbose: "terminal",
  fast: "zap",
  agents: "monitor",
  subagents: "folder",
  steer: "send",
  tts: "volume2",
};

const INLINE_MULTI_WORD_COMMANDS = new Set(["dashboard"]);

const LOCAL_COMMANDS = new Set([
  "help",
  "new",
  "reset",
  "stop",
  "compact",
  "model",
  "think",
  "fast",
  "verbose",
  "export-session",
  "usage",
  "agents",
  "steer",
  "redirect",
]);

const UI_ONLY_COMMANDS: SlashCommandDef[] = [
  {
    key: "clear",
    name: "clear",
    description: "Clear chat history",
    descriptionKey: "chat.commands.clearDescription",
    icon: "trash",
    category: "session",
    executeLocal: true,
    tier: "standard",
  },
  {
    key: "redirect",
    name: "redirect",
    description: "Abort and restart with a new message",
    descriptionKey: "chat.commands.redirectDescription",
    args: "<message>",
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
  steer: "agents",
  redirect: "agents",
  session: "session",
  stop: "session",
  reset: "session",
  new: "session",
  compact: "session",
  model: "model",
  models: "model",
  think: "model",
  verbose: "model",
  fast: "model",
  reasoning: "model",
  elevated: "model",
  queue: "model",
};

const COMMAND_DESCRIPTION_KEYS: Partial<Record<string, string>> = {
  steer: "chat.commands.steerDescription",
};

const COMMAND_DESCRIPTION_OVERRIDES: Partial<Record<string, string>> = {
  steer: "Inject a message into the active run",
};

const COMMAND_ARGS_OVERRIDES: Partial<Record<string, string>> = {
  steer: "<message>",
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

function choiceToValue(command: CommandLike, argName: string, choice: LocalArgChoice): string {
  const value = typeof choice === "string" ? choice : choice.value;
  return command.formatArgs?.({ [argName]: value }) ?? value;
}

function getArgOptions(command: CommandLike): string[] | undefined {
  const firstArg = command.args?.[0];
  if (!firstArg) {
    return undefined;
  }
  const options = firstArg.choices
    ?.map((choice) => choiceToValue(command, firstArg.name, choice))
    .filter(Boolean);
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
  const resolvedSource = command.source ?? (source === "local" ? "native" : undefined);
  return {
    key: command.key,
    name,
    aliases: getSlashAliases(command).filter((alias) => alias !== name),
    description: COMMAND_DESCRIPTION_OVERRIDES[command.key] ?? command.description,
    ...(COMMAND_DESCRIPTION_KEYS[command.key]
      ? { descriptionKey: COMMAND_DESCRIPTION_KEYS[command.key] }
      : {}),
    args: COMMAND_ARGS_OVERRIDES[command.key] ?? formatArgs(command),
    icon: mapIcon(command),
    category: mapCategory(command),
    executeLocal: source === "local" && LOCAL_COMMANDS.has(command.key),
    argOptions: getArgOptions(command),
    allowsInlineMultiWordArgs: INLINE_MULTI_WORD_COMMANDS.has(command.key),
    tier: source === "local" ? mapTier(command) : "standard",
    ...(resolvedSource ? { source: resolvedSource } : {}),
    ...(command.skillDisplayName ? { skillDisplayName: command.skillDisplayName } : {}),
    ...(command.skillModelVisible !== undefined
      ? { skillModelVisible: command.skillModelVisible }
      : {}),
    ...(command.clientPresentation ? { clientPresentation: command.clientPresentation } : {}),
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
  return text.length > maxLength ? truncateUtf16Safe(text, maxLength) : text;
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

function normalizeClientPresentation(
  value: unknown,
): NonNullable<CommandEntry["clientPresentation"]> | undefined {
  const presentation = asRecord(value);
  if (
    !presentation ||
    Object.keys(presentation).length !== 2 ||
    !Object.hasOwn(presentation, "when") ||
    !Object.hasOwn(presentation, "action") ||
    presentation.when !== "no-arguments"
  ) {
    return undefined;
  }
  const action = asRecord(presentation.action);
  if (
    !action ||
    Object.keys(action).length !== 1 ||
    !Object.hasOwn(action, "kind") ||
    action.kind !== "device-pairing"
  ) {
    return undefined;
  }
  return { when: "no-arguments", action: { kind: "device-pairing" } };
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
      formatArgs: command.formatArgs,
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
    source:
      entry.source === "native" || entry.source === "plugin" || entry.source === "skill"
        ? entry.source
        : undefined,
    skillDisplayName:
      typeof entry.skillDisplayName === "string"
        ? clampText(entry.skillDisplayName, MAX_REMOTE_NAME_LENGTH).trim() || undefined
        : undefined,
    skillModelVisible:
      typeof entry.skillModelVisible === "boolean" ? entry.skillModelVisible : undefined,
    clientPresentation:
      entry.source === "plugin" ? normalizeClientPresentation(entry.clientPresentation) : undefined,
  };
}

export function replaceSlashCommands(next: SlashCommandDef[]) {
  SLASH_COMMANDS.splice(0, SLASH_COMMANDS.length, ...next);
}

export function buildSlashCommandsFromEntries(entries: CommandEntry[]): SlashCommandDef[] {
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

export function getRemoteCommandEntries(
  result: { commands?: unknown } | null | undefined,
): CommandEntry[] {
  const commands = result?.commands;
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands
    .map((entry) => asRecord(entry))
    .filter((entry): entry is CommandEntry => entry !== null);
}

export function buildFallbackSlashCommands(): SlashCommandDef[] {
  return buildLocalSlashCommands();
}

export const SLASH_COMMANDS: SlashCommandDef[] = buildFallbackSlashCommands();

const CATEGORY_ORDER: SlashCommandCategory[] = ["session", "model", "tools", "agents"];

export function getSlashCommandCategoryLabel(category: SlashCommandCategory): string {
  return t(`chat.commands.categories.${category}`);
}

export function getSlashCommandDescription(command: SlashCommandDef): string {
  return command.descriptionKey ? t(command.descriptionKey) : command.description;
}

const TIER_ORDER: Record<SlashCommandTier, number> = {
  essential: 0,
  standard: 1,
  power: 2,
};

const NON_MATCHING_COMMAND_RANK = 4;

function getSlashCommandRelevance(command: SlashCommandDef, filter: string): number {
  const names = [command.name, ...(command.aliases ?? [])].map(normalizeLowercaseStringOrEmpty);
  if (names.some((name) => name === filter)) {
    return 0;
  }
  if (names.some((name) => name.startsWith(filter))) {
    return 1;
  }
  if (names.some((name) => name.includes(filter))) {
    return 2;
  }
  return normalizeLowercaseStringOrEmpty(getSlashCommandDescription(command)).includes(filter)
    ? 3
    : NON_MATCHING_COMMAND_RANK;
}

export function getSlashCommandCompletions(
  filter: string,
  options?: {
    showAll?: boolean;
    inlineOnly?: boolean;
    allowImmediateInlineCommands?: boolean;
  },
): SlashCommandDef[] {
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const showAll = options?.showAll ?? false;
  let commands = options?.inlineOnly
    ? SLASH_COMMANDS.filter(
        (command) =>
          (command.source === "skill" && command.skillModelVisible === true) ||
          (executesInlineImmediately(command) && options.allowImmediateInlineCommands !== false),
      )
    : SLASH_COMMANDS;
  commands = lower
    ? commands.filter(
        (command) => getSlashCommandRelevance(command, lower) < NON_MATCHING_COMMAND_RANK,
      )
    : commands;

  // When no filter text and not explicitly showing all, hide "power" tier commands
  if (!lower && !showAll) {
    commands = commands.filter((cmd) => (cmd.tier ?? "standard") !== "power");
  }

  return commands.toSorted((a, b) => {
    if (lower) {
      const relevance = getSlashCommandRelevance(a, lower) - getSlashCommandRelevance(b, lower);
      if (relevance !== 0) {
        return relevance;
      }
    }
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
    return 0;
  });
}

export type InlineSlashCompletion = {
  query: string;
  start: number;
  end: number;
  inline: boolean;
  skillOnly?: boolean;
  argumentStart?: number;
};

/** Finds the slash token being edited at the caret, including inside normal prose. */
export function findInlineSlashCompletion(
  text: string,
  caret = text.length,
): InlineSlashCompletion | null {
  const boundedCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, boundedCaret);
  const match = prefix.match(/(?:^|\s)\/([^\s/:]*)(:?)$/u);
  if (!match || match.index === undefined) {
    return null;
  }
  const slashOffset = match[0].indexOf("/");
  const start = match.index + slashOffset;
  if (text[start + 1] === "/") {
    return null;
  }
  let end = boundedCaret;
  while (end < text.length && !/\s/u.test(text[end] ?? "")) {
    end += 1;
  }
  const query = match[1] ?? "";
  if (!/^[^\s/:]*$/u.test(query)) {
    return null;
  }
  return {
    query,
    start,
    end,
    inline:
      text.slice(0, start).trim().length > 0 ||
      text.slice(end).trim().length > 0 ||
      match[2] === ":",
    ...(match[2] === ":" ? { skillOnly: true } : {}),
  };
}

export function getSkillDisplayName(command: SlashCommandDef): string {
  return command.skillDisplayName?.trim() || command.name;
}

export function getSkillCommandCompletions(filter: string): SlashCommandDef[] {
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const normalized = lower.replace(/[\s_]+/gu, "-");
  return SLASH_COMMANDS.filter(
    (command) => command.source === "skill" && command.skillModelVisible === true,
  )
    .filter((command) => {
      const displayName = normalizeLowercaseStringOrEmpty(getSkillDisplayName(command));
      const displayLookup = displayName.replace(/[\s_]+/gu, "-");
      const commandLookup = normalizeLowercaseStringOrEmpty(command.name).replace(/[\s_]+/gu, "-");
      return (
        !lower ||
        displayName.includes(lower) ||
        displayLookup.includes(normalized) ||
        commandLookup.startsWith(normalized) ||
        normalizeLowercaseStringOrEmpty(getSlashCommandDescription(command)).includes(lower)
      );
    })
    .toSorted((left, right) => getSkillDisplayName(left).localeCompare(getSkillDisplayName(right)));
}

type ParsedSlashCommand = {
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
