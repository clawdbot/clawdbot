// Command list serialization gathers chat, skill, and plugin commands into the
// gateway protocol result while clamping names, descriptions, aliases, and args.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  CommandEntry,
  CommandsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  COMMAND_ALIAS_MAX_ITEMS,
  COMMAND_ARG_CHOICES_MAX_ITEMS,
  COMMAND_ARG_DESCRIPTION_MAX_LENGTH,
  COMMAND_ARG_NAME_MAX_LENGTH,
  COMMAND_ARGS_MAX_ITEMS,
  COMMAND_CHOICE_LABEL_MAX_LENGTH,
  COMMAND_CHOICE_VALUE_MAX_LENGTH,
  COMMAND_DESCRIPTION_MAX_LENGTH,
  COMMAND_LIST_MAX_ITEMS,
  COMMAND_NAME_MAX_LENGTH,
} from "../../../packages/gateway-protocol/src/schema.js";
import { listChatCommandsForConfig } from "../../auto-reply/commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgChoice,
  CommandArgDefinition,
} from "../../auto-reply/commands-registry.types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getPluginCommandEntrySpecs,
  getPluginCommandEntrySpecsFromRegistrations,
} from "../../plugins/command-specs.js";
import { getActivePluginGatewayCommandRegistry } from "../../plugins/runtime.js";
import { listSkillCommandsForAgents } from "../../skills/discovery/chat-commands.js";

type SerializedArg = NonNullable<CommandEntry["args"]>[number];
type CommandNameSurface = "text" | "native";

function clampString(value: string, maxLength: number): string {
  return value.length > maxLength ? truncateUtf16Safe(value, maxLength) : value;
}

function trimClampNonEmpty(value: string, maxLength: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return clampString(trimmed, maxLength);
}

function clampDescription(value: string | undefined): string {
  return clampString(value ?? "", COMMAND_DESCRIPTION_MAX_LENGTH);
}

function resolveNativeName(cmd: ChatCommandDefinition, provider?: string): string {
  const baseName = cmd.nativeName ?? cmd.key;
  if (!provider || !cmd.nativeName) {
    return baseName;
  }
  return (
    getChannelPlugin(provider)?.commands?.resolveNativeCommandName?.({
      commandKey: cmd.key,
      defaultName: cmd.nativeName,
    }) ?? baseName
  );
}

function supportsNativeProvider(cmd: ChatCommandDefinition, provider?: string): boolean {
  if (!cmd.nativeProviders?.length) {
    return true;
  }
  if (!provider) {
    return true;
  }
  return cmd.nativeProviders.some(
    (candidate) => normalizeOptionalLowercaseString(candidate) === provider,
  );
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

/** Resolves normalized text aliases, preserving slash-prefixed command names. */
function resolveTextAliases(cmd: ChatCommandDefinition): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const alias of cmd.textAliases) {
    const trimmed = trimClampNonEmpty(alias, COMMAND_NAME_MAX_LENGTH);
    if (!trimmed) {
      continue;
    }
    const exactAlias = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (seen.has(exactAlias)) {
      continue;
    }
    seen.add(exactAlias);
    aliases.push(exactAlias);
    if (aliases.length >= COMMAND_ALIAS_MAX_ITEMS) {
      break;
    }
  }
  if (aliases.length > 0) {
    return aliases;
  }
  return [`/${clampString(cmd.key, COMMAND_NAME_MAX_LENGTH)}`];
}

function resolvePrimaryTextName(cmd: ChatCommandDefinition): string {
  return stripLeadingSlash(resolveTextAliases(cmd)[0] ?? `/${cmd.key}`);
}

/** Serializes a command argument into the bounded gateway protocol shape. */
function serializeArg(arg: CommandArgDefinition): SerializedArg {
  const isDynamic = typeof arg.choices === "function";
  const staticChoices = Array.isArray(arg.choices)
    ? arg.choices.slice(0, COMMAND_ARG_CHOICES_MAX_ITEMS).map(normalizeChoice)
    : undefined;
  return {
    name: clampString(arg.name, COMMAND_ARG_NAME_MAX_LENGTH),
    description: clampString(arg.description, COMMAND_ARG_DESCRIPTION_MAX_LENGTH),
    type: arg.type,
    ...(arg.required ? { required: true } : {}),
    ...(staticChoices ? { choices: staticChoices } : {}),
    ...(isDynamic ? { dynamic: true } : {}),
  };
}

function normalizeChoice(choice: CommandArgChoice): { value: string; label: string } {
  if (typeof choice === "string") {
    const value = clampString(choice, COMMAND_CHOICE_VALUE_MAX_LENGTH);
    return {
      value,
      label: clampString(choice, COMMAND_CHOICE_LABEL_MAX_LENGTH),
    };
  }
  return {
    value: clampString(choice.value, COMMAND_CHOICE_VALUE_MAX_LENGTH),
    label: clampString(choice.label, COMMAND_CHOICE_LABEL_MAX_LENGTH),
  };
}

function mapCommand(
  cmd: ChatCommandDefinition,
  source: "native" | "skill",
  includeArgs: boolean,
  nameSurface: CommandNameSurface,
  provider?: string,
): CommandEntry {
  const shouldIncludeArgs = includeArgs && cmd.acceptsArgs && cmd.args?.length;
  const nativeName = cmd.scope === "text" ? undefined : resolveNativeName(cmd, provider);
  return {
    name: clampString(
      nameSurface === "text" ? resolvePrimaryTextName(cmd) : (nativeName ?? cmd.key),
      COMMAND_NAME_MAX_LENGTH,
    ),
    ...(nativeName ? { nativeName: clampString(nativeName, COMMAND_NAME_MAX_LENGTH) } : {}),
    ...(cmd.scope !== "native" ? { textAliases: resolveTextAliases(cmd) } : {}),
    description: clampDescription(cmd.description),
    ...(cmd.category ? { category: cmd.category } : {}),
    source,
    scope: cmd.scope,
    acceptsArgs: Boolean(cmd.acceptsArgs),
    ...(shouldIncludeArgs
      ? { args: cmd.args!.slice(0, COMMAND_ARGS_MAX_ITEMS).map(serializeArg) }
      : {}),
  };
}

/** Builds plugin command entries from text specs plus provider-native metadata. */
function buildPluginCommandEntries(params: {
  provider?: string;
  nameSurface: CommandNameSurface;
  cfg: OpenClawConfig;
}): CommandEntry[] {
  const gatewayRegistry = getActivePluginGatewayCommandRegistry();
  const pluginSpecs = gatewayRegistry
    ? getPluginCommandEntrySpecsFromRegistrations(gatewayRegistry.commands, params.provider, {
        config: params.cfg,
      })
    : getPluginCommandEntrySpecs(params.provider, { config: params.cfg });
  const entries: CommandEntry[] = [];

  for (const spec of pluginSpecs) {
    entries.push({
      name: clampString(
        params.nameSurface === "text" ? spec.name : (spec.nativeName ?? spec.name),
        COMMAND_NAME_MAX_LENGTH,
      ),
      ...(spec.nativeName
        ? { nativeName: clampString(spec.nativeName, COMMAND_NAME_MAX_LENGTH) }
        : {}),
      textAliases: [`/${clampString(spec.name, COMMAND_NAME_MAX_LENGTH)}`],
      description: clampDescription(spec.description),
      source: "plugin",
      scope: "both",
      acceptsArgs: spec.acceptsArgs,
    });
  }

  if (params.nameSurface === "native") {
    return entries.filter((entry) => entry.nativeName);
  }
  return entries;
}

/** Builds the public commands.list payload for an agent/provider/scope view. */
export function buildCommandsListResult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  scope?: "native" | "text" | "both";
  includeArgs?: boolean;
}): CommandsListResult {
  const includeArgs = params.includeArgs !== false;
  const scopeFilter = params.scope ?? "both";
  const nameSurface: CommandNameSurface = scopeFilter === "text" ? "text" : "native";
  const provider = normalizeOptionalLowercaseString(params.provider);

  const skillCommands = listSkillCommandsForAgents({ cfg: params.cfg, agentIds: [params.agentId] });
  const chatCommands = listChatCommandsForConfig(params.cfg, { skillCommands });
  const skillKeys = new Set(skillCommands.map((sc) => `skill:${sc.skillName}`));

  const commands: CommandEntry[] = [];

  for (const cmd of chatCommands) {
    if (scopeFilter !== "both" && cmd.scope !== "both" && cmd.scope !== scopeFilter) {
      continue;
    }
    if (
      nameSurface === "native" &&
      cmd.scope !== "text" &&
      !supportsNativeProvider(cmd, provider)
    ) {
      continue;
    }
    commands.push(
      mapCommand(
        cmd,
        skillKeys.has(cmd.key) ? "skill" : "native",
        includeArgs,
        nameSurface,
        provider,
      ),
    );
  }

  commands.push(...buildPluginCommandEntries({ provider, nameSurface, cfg: params.cfg }));

  return { commands: commands.slice(0, COMMAND_LIST_MAX_ITEMS) };
}
