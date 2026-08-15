import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexComputerUseConfig } from "./app-server/config.js";
import {
  buildCodexCommandPickerPresentation,
  type CodexCommandPickerButton,
} from "./command-presentation.js";

type ParsedBindArgs = {
  threadId?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  help?: boolean;
};

type ParsedComputerUseArgs = {
  action: "status" | "install";
  overrides: Partial<CodexComputerUseConfig>;
  hasOverrides: boolean;
  persistentIdentity: Partial<Pick<CodexComputerUseConfig, "pluginName" | "mcpServerName">>;
  help?: boolean;
};

type ParsedCodexCliSessionsArgs = {
  host?: string;
  filter: string;
  limit?: number;
  help?: boolean;
};

export type ParsedResumeArgs = {
  threadId?: string;
  host?: string;
  bindHere?: boolean;
  help?: boolean;
};

/** No-arg `/codex` picker. */
export function buildCodexSubcommandPickerReply(): PluginCommandResult {
  const verbs: CodexCommandPickerButton[] = [
    { label: "plugins", command: "/codex plugins menu" },
    { label: "permissions", command: "/codex permissions menu" },
    { label: "fast", command: "/codex fast menu" },
    { label: "computer-use", command: "/codex computer-use menu" },
    { label: "account", command: "/codex account" },
    { label: "help", command: "/codex help" },
  ];
  const fallbackTextLines = [
    "Codex commands. Pick a category or type:",
    "",
    ...verbs.map((v, i) => `  ${i + 1}. ${v.command}`),
    "",
    "Tap 'help' (or type /codex help) for the full list of typeable verbs",
    "including threads, mcp, binding, detach, skills, resume, bind, steer,",
    "model, diagnostics, compact, review, computer-use.",
    "",
    "Top-level shortcuts cover everyday operations: /status, /fast, /help, /stop, /models.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex commands",
      "Pick a Codex subcommand:",
      verbs,
    ),
  };
}

export function buildCodexFastMenuReply(): PluginCommandResult {
  const modes = ["on", "off", "status"] as const;
  const buttons: CodexCommandPickerButton[] = [
    ...modes.map((mode) => ({ label: mode, command: `/codex fast ${mode}` })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    "Codex fast mode. Pick one or type /codex fast <mode>:",
    "",
    ...modes.map((m, i) => `  ${i + 1}. /codex fast ${m}`),
    "",
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex fast mode",
      "Pick a Codex fast mode:",
      buttons,
    ),
  };
}

export function buildCodexPermissionsMenuReply(): PluginCommandResult {
  const modes = ["default", "yolo", "status"] as const;
  const buttons: CodexCommandPickerButton[] = [
    ...modes.map((mode) => ({ label: mode, command: `/codex permissions ${mode}` })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    "Codex permissions. Pick one or type /codex permissions <mode>:",
    "",
    ...modes.map((m, i) => `  ${i + 1}. /codex permissions ${m}`),
    "",
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex permissions",
      "Pick a Codex permissions mode:",
      buttons,
    ),
  };
}

export function buildCodexComputerUseMenuReply(): PluginCommandResult {
  const actions = ["status", "install"] as const;
  const buttons: CodexCommandPickerButton[] = [
    ...actions.map((action) => ({
      label: action,
      command: `/codex computer-use ${action}`,
    })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    "Codex computer-use. Pick one or type /codex computer-use <action>:",
    "",
    ...actions.map((a, i) => `  ${i + 1}. /codex computer-use ${a}`),
    "",
    "Flag-driven invocations (--source, --marketplace-path, --marketplace) are not in the picker. Type '/codex computer-use' or read '/codex help' for the full surface.",
    "",
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex computer-use",
      "Pick a Codex computer-use action:",
      buttons,
    ),
  };
}

export function isMenuVerb(rest: readonly string[]): boolean {
  return rest.length === 1 && (rest[0] ?? "").trim().toLowerCase() === "menu";
}

export function splitArgs(value: string | undefined): string[] {
  const input = value ?? "";
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (escaping) {
    current += "\\";
  }
  if (tokenStarted) {
    args.push(current);
  }
  return args;
}

export function parseBindArgs(args: string[]): ParsedBindArgs {
  const parsed: ParsedBindArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(args[index], "current Codex bind argument");
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--cwd") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.cwd !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.cwd = value;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.model !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.model = value;
      index += 1;
      continue;
    }
    if (arg === "--provider" || arg === "--model-provider") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.provider !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.provider = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && !parsed.threadId) {
      parsed.threadId = arg;
      continue;
    }
    parsed.help = true;
  }
  parsed.threadId = normalizeOptionalString(parsed.threadId);
  parsed.cwd = normalizeOptionalString(parsed.cwd);
  parsed.model = normalizeOptionalString(parsed.model);
  parsed.provider = normalizeOptionalString(parsed.provider);
  return parsed;
}

export function parseCodexCliSessionsArgs(args: string[]): ParsedCodexCliSessionsArgs {
  const parsed: ParsedCodexCliSessionsArgs = { filter: "" };
  const filter: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(args[index], "current Codex sessions argument");
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--host" || arg === "--node") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.host !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.host = value;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = readRequiredOptionValue(args, index);
      const parsedLimit = parseStrictPositiveInteger(value);
      if (parsedLimit === undefined) {
        parsed.help = true;
        continue;
      }
      parsed.limit = parsedLimit;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      parsed.help = true;
      continue;
    }
    filter.push(arg);
  }
  parsed.host = normalizeOptionalString(parsed.host);
  parsed.filter = filter.join(" ").trim();
  return parsed;
}

export function parseResumeArgs(args: string[]): ParsedResumeArgs {
  const parsed: ParsedResumeArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(args[index], "current Codex resume argument");
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--host" || arg === "--node") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.host !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.host = value;
      index += 1;
      continue;
    }
    if (arg === "--bind") {
      const value = readRequiredOptionValue(args, index);
      if (value !== "here" || parsed.bindHere !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.bindHere = true;
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && !parsed.threadId) {
      parsed.threadId = arg;
      continue;
    }
    parsed.help = true;
  }
  parsed.threadId = normalizeOptionalString(parsed.threadId);
  parsed.host = normalizeOptionalString(parsed.host);
  return parsed;
}

export function parseComputerUseArgs(args: string[]): ParsedComputerUseArgs {
  const parsed: ParsedComputerUseArgs = {
    action: "status",
    overrides: {},
    hasOverrides: false,
    persistentIdentity: {},
  };
  let sawAction = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "status" || arg === "install") {
      if (sawAction) {
        parsed.help = true;
        continue;
      }
      sawAction = true;
      parsed.action = arg;
      continue;
    }
    if (arg === "--source" || arg === "--marketplace-source") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.marketplaceSource !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplaceSource = value;
      index += 1;
      continue;
    }
    if (arg === "--marketplace-path" || arg === "--path") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.marketplacePath !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplacePath = value;
      index += 1;
      continue;
    }
    if (arg === "--marketplace") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.marketplaceName !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplaceName = value;
      index += 1;
      continue;
    }
    if (arg === "--plugin" || arg === "--server" || arg === "--mcp-server") {
      const value = readRequiredOptionValue(args, index);
      const configKey = arg === "--plugin" ? "pluginName" : "mcpServerName";
      if (!value || parsed.persistentIdentity[configKey] !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.persistentIdentity[configKey] = value.trim();
      index += 1;
      continue;
    }
    parsed.help = true;
  }
  parsed.overrides = normalizeComputerUseStringOverrides(parsed.overrides);
  parsed.hasOverrides = Object.values(parsed.overrides).some(Boolean);
  return parsed;
}

export function formatComputerUsePersistentIdentityMigration(
  parsed: ParsedComputerUseArgs,
): string {
  const configPrefix = "plugins.entries.codex.config.computerUse";
  const settings = [
    parsed.persistentIdentity.pluginName
      ? `${configPrefix}.pluginName = ${JSON.stringify(parsed.persistentIdentity.pluginName)}`
      : undefined,
    parsed.persistentIdentity.mcpServerName
      ? `${configPrefix}.mcpServerName = ${JSON.stringify(parsed.persistentIdentity.mcpServerName)}`
      : undefined,
  ].filter((setting): setting is string => Boolean(setting));
  const retryArgs = [
    `/codex computer-use ${parsed.action}`,
    parsed.overrides.marketplaceSource
      ? `--source ${JSON.stringify(parsed.overrides.marketplaceSource)}`
      : undefined,
    parsed.overrides.marketplacePath
      ? `--marketplace-path ${JSON.stringify(parsed.overrides.marketplacePath)}`
      : undefined,
    parsed.overrides.marketplaceName
      ? `--marketplace ${JSON.stringify(parsed.overrides.marketplaceName)}`
      : undefined,
  ].filter((arg): arg is string => Boolean(arg));
  return [
    "One-off Computer Use plugin/server overrides are no longer supported.",
    `Set ${settings.join(" and ")} persistently, then rerun ${retryArgs.join(" ")}.`,
  ].join(" ");
}

function readRequiredOptionValue(args: string[], index: number): string | undefined {
  const value = args[index + 1];
  const normalized = value?.trim();
  if (!normalized || normalized.startsWith("-")) {
    return undefined;
  }
  return value;
}

function normalizeComputerUseStringOverrides(
  overrides: Partial<CodexComputerUseConfig>,
): Partial<CodexComputerUseConfig> {
  const normalized: Partial<CodexComputerUseConfig> = {};
  const marketplaceSource = normalizeOptionalString(overrides.marketplaceSource);
  if (marketplaceSource) {
    normalized.marketplaceSource = marketplaceSource;
  }
  const marketplacePath = normalizeOptionalString(overrides.marketplacePath);
  if (marketplacePath) {
    normalized.marketplacePath = marketplacePath;
  }
  const marketplaceName = normalizeOptionalString(overrides.marketplaceName);
  if (marketplaceName) {
    normalized.marketplaceName = marketplaceName;
  }
  return normalized;
}
