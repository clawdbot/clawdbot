import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildConfiguredModelCatalog,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import type { SkillCommandSpec } from "../agents/skills.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import {
  isCommandEnabled,
  listChatCommands,
  listChatCommandsForConfig,
} from "./commands-registry-list.js";
import { normalizeCommandBody, resolveTextCommand } from "./commands-registry-normalize.js";
import { getChatCommands, getNativeCommandSurfaces } from "./commands-registry.data.js";
import type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  NativeCommandSpec,
  ShouldHandleTextCommandsParams,
} from "./commands-registry.types.js";
import type { ThinkingCatalogEntry } from "./thinking.shared.js";

export {
  isCommandEnabled,
  listChatCommands,
  listChatCommandsForConfig,
} from "./commands-registry-list.js";

export {
  getCommandDetection,
  maybeResolveTextAlias,
  normalizeCommandBody,
  resolveTextCommand,
} from "./commands-registry-normalize.js";

export type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  CommandScope,
  NativeCommandSpec,
  ShouldHandleTextCommandsParams,
} from "./commands-registry.types.js";

type NativeCommandProviderLookupOptions = {
  includeBundledChannelFallback?: boolean;
};

function resolveNativeName(
  command: ChatCommandDefinition,
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): string | undefined {
  if (!command.nativeName) {
    return undefined;
  }
  if (!provider) {
    return command.nativeName;
  }
  const channelPlugin =
    options?.includeBundledChannelFallback === false
      ? getLoadedChannelPlugin(provider)
      : getChannelPlugin(provider);
  return (
    channelPlugin?.commands?.resolveNativeCommandName?.({
      commandKey: command.key,
      defaultName: command.nativeName,
    }) ?? command.nativeName
  );
}

function toNativeCommandSpec(command: ChatCommandDefinition, provider?: string): NativeCommandSpec {
  return {
    name: resolveNativeName(command, provider) ?? command.key,
    description: command.description,
    acceptsArgs: Boolean(command.acceptsArgs),
    args: command.args,
  };
}

function listNativeSpecsFromCommands(
  commands: ChatCommandDefinition[],
  provider?: string,
): NativeCommandSpec[] {
  return commands
    .filter((command) => command.scope !== "text" && command.nativeName)
    .map((command) => toNativeCommandSpec(command, provider));
}

export function listNativeCommandSpecs(params?: {
  skillCommands?: SkillCommandSpec[];
  provider?: string;
}): NativeCommandSpec[] {
  return listNativeSpecsFromCommands(
    listChatCommands({ skillCommands: params?.skillCommands }),
    params?.provider,
  );
}

export function listNativeCommandSpecsForConfig(
  cfg: OpenClawConfig,
  params?: { skillCommands?: SkillCommandSpec[]; provider?: string },
): NativeCommandSpec[] {
  return listNativeSpecsFromCommands(listChatCommandsForConfig(cfg, params), params?.provider);
}

export function findCommandByNativeName(
  name: string,
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): ChatCommandDefinition | undefined {
  const normalized = normalizeOptionalLowercaseString(name);
  if (!normalized) {
    return undefined;
  }
  return getChatCommands().find(
    (command) =>
      command.scope !== "text" &&
      normalizeOptionalLowercaseString(resolveNativeName(command, provider, options)) ===
        normalized,
  );
}

export function buildCommandText(commandName: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}

function parsePositionalArgs(definitions: CommandArgDefinition[], raw: string): CommandArgValues {
  const values: CommandArgValues = {};
  const trimmed = raw.trim();
  if (!trimmed) {
    return values;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let index = 0;
  for (const definition of definitions) {
    if (index >= tokens.length) {
      break;
    }
    if (definition.captureRemaining) {
      values[definition.name] = tokens.slice(index).join(" ");
      index = tokens.length;
      break;
    }
    values[definition.name] = tokens[index];
    index += 1;
  }
  return values;
}

function formatPositionalArgs(
  definitions: CommandArgDefinition[],
  values: CommandArgValues,
): string | undefined {
  const parts: string[] = [];
  for (const definition of definitions) {
    const value = values[definition.name];
    if (value == null) {
      continue;
    }
    let rendered: string;
    if (typeof value === "string") {
      rendered = value.trim();
    } else {
      rendered = String(value);
    }
    if (!rendered) {
      continue;
    }
    parts.push(rendered);
    if (definition.captureRemaining) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function parseCommandArgs(
  command: ChatCommandDefinition,
  raw?: string,
): CommandArgs | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!command.args || command.argsParsing === "none") {
    return { raw: trimmed };
  }
  return {
    raw: trimmed,
    values: parsePositionalArgs(command.args, trimmed),
  };
}

export function serializeCommandArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string | undefined {
  if (!args) {
    return undefined;
  }
  const raw = args.raw?.trim();
  if (raw) {
    return raw;
  }
  if (!args.values || !command.args) {
    return undefined;
  }
  if (command.formatArgs) {
    return command.formatArgs(args.values);
  }
  return formatPositionalArgs(command.args, args.values);
}

export function buildCommandTextFromArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string {
  const commandName = command.nativeName ?? command.key;
  return buildCommandText(commandName, serializeCommandArgs(command, args));
}

function resolveDefaultCommandContext(cfg?: OpenClawConfig): {
  provider: string;
  model: string;
} {
  const resolved = resolveConfiguredModelRef({
    cfg: cfg ?? ({} as OpenClawConfig),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  return {
    provider: resolved.provider ?? DEFAULT_PROVIDER,
    model: resolved.model ?? DEFAULT_MODEL,
  };
}

export type ResolvedCommandArgChoice = { value: string; label: string };

export function resolveCommandArgChoices(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  catalog?: ThinkingCatalogEntry[];
}): ResolvedCommandArgChoice[] {
  const { command, arg, cfg } = params;
  if (!arg.choices) {
    return [];
  }
  const provided = arg.choices;
  const raw = Array.isArray(provided)
    ? provided
    : (() => {
        const defaults = resolveDefaultCommandContext(cfg);
        const context: CommandArgChoiceContext = {
          cfg,
          provider: params.provider ?? defaults.provider,
          model: params.model ?? defaults.model,
          catalog: params.catalog ?? (cfg ? buildConfiguredModelCatalog({ cfg }) : undefined),
          command,
          arg,
        };
        return provided(context);
      })();
  return raw.map((choice) =>
    typeof choice === "string" ? { value: choice, label: choice } : choice,
  );
}

export function resolveCommandArgMenu(params: {
  command: ChatCommandDefinition;
  args?: CommandArgs;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  catalog?: ThinkingCatalogEntry[];
}): { arg: CommandArgDefinition; choices: ResolvedCommandArgChoice[]; title?: string } | null {
  const { command, args, cfg, provider, model, catalog } = params;
  if (!command.args || !command.argsMenu) {
    return null;
  }
  if (command.argsParsing === "none") {
    return null;
  }
  const resolvedCatalog = catalog ?? (cfg ? buildConfiguredModelCatalog({ cfg }) : undefined);
  const argSpec = command.argsMenu;
  const argName =
    argSpec === "auto"
      ? command.args.find(
          (arg) =>
            resolveCommandArgChoices({
              command,
              arg,
              cfg,
              provider,
              model,
              catalog: resolvedCatalog,
            }).length > 0,
        )?.name
      : argSpec.arg;
  if (!argName) {
    return null;
  }
  if (args?.values && args.values[argName] != null) {
    return null;
  }
  if (args?.raw && !args.values) {
    return null;
  }
  const arg = command.args.find((entry) => entry.name === argName);
  if (!arg) {
    return null;
  }
  const choices = resolveCommandArgChoices({
    command,
    arg,
    cfg,
    provider,
    model,
    catalog: resolvedCatalog,
  });
  if (choices.length === 0) {
    return null;
  }
  const title = argSpec !== "auto" ? argSpec.title : undefined;
  return { arg, choices, title };
}

export function formatCommandArgMenuTitle(params: {
  command: ChatCommandDefinition;
  menu: NonNullable<ReturnType<typeof resolveCommandArgMenu>>;
}): string {
  const { command, menu } = params;
  if (menu.title) {
    return menu.title;
  }
  const commandLabel = command.nativeName ?? command.key;
  if (typeof menu.arg.choices === "function") {
    const options = menu.choices
      .map((choice) => choice.label.trim())
      .filter(Boolean)
      .join(", ");
    if (options.length > 0 && options.length <= 160) {
      return `Choose ${menu.arg.name} for /${commandLabel}.\nOptions: ${options}.`;
    }
    return `Choose ${menu.arg.name} for /${commandLabel}.`;
  }
  return `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
}

export function isCommandMessage(raw: string): boolean {
  const trimmed = normalizeCommandBody(raw);
  return trimmed.startsWith("/");
}

export function isNativeCommandSurface(surface?: string): boolean {
  if (!surface) {
    return false;
  }
  return getNativeCommandSurfaces().has(normalizeLowercaseStringOrEmpty(surface));
}

export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native") {
    return true;
  }
  if (params.cfg.commands?.text !== false) {
    return true;
  }
  return !isNativeCommandSurface(params.surface);
}
