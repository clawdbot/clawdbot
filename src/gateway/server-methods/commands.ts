import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChatCommandsForConfig } from "../../auto-reply/commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgChoice,
  CommandArgDefinition,
} from "../../auto-reply/commands-registry.types.js";
import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginCommandSpecs } from "../../plugins/command-registry-state.js";
import { listPluginCommands } from "../../plugins/commands.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { CommandEntry, CommandsListResult } from "../protocol/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCommandsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type SerializedArg = NonNullable<CommandEntry["args"]>[number];
type CommandNameSurface = "text" | "native";

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId };
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

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function resolveTextAliases(cmd: ChatCommandDefinition): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const alias of cmd.textAliases) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const exactAlias = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (seen.has(exactAlias)) {
      continue;
    }
    seen.add(exactAlias);
    aliases.push(exactAlias);
  }
  if (aliases.length > 0) {
    return aliases;
  }
  return [`/${cmd.key}`];
}

function resolvePrimaryTextName(cmd: ChatCommandDefinition): string {
  return stripLeadingSlash(resolveTextAliases(cmd)[0] ?? `/${cmd.key}`);
}

function serializeArg(arg: CommandArgDefinition): SerializedArg {
  const isDynamic = typeof arg.choices === "function";
  const staticChoices = Array.isArray(arg.choices) ? arg.choices.map(normalizeChoice) : undefined;
  return {
    name: arg.name,
    description: arg.description,
    type: arg.type,
    ...(arg.required ? { required: true } : {}),
    ...(staticChoices ? { choices: staticChoices } : {}),
    ...(isDynamic ? { dynamic: true } : {}),
  };
}

function normalizeChoice(choice: CommandArgChoice): { value: string; label: string } {
  return typeof choice === "string" ? { value: choice, label: choice } : choice;
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
    name: nameSurface === "text" ? resolvePrimaryTextName(cmd) : (nativeName ?? cmd.key),
    ...(nativeName ? { nativeName } : {}),
    ...(cmd.scope !== "native" ? { textAliases: resolveTextAliases(cmd) } : {}),
    description: cmd.description,
    ...(cmd.category ? { category: cmd.category } : {}),
    source,
    scope: cmd.scope,
    acceptsArgs: Boolean(cmd.acceptsArgs),
    ...(shouldIncludeArgs ? { args: cmd.args!.map(serializeArg) } : {}),
  };
}

function buildPluginCommandEntries(params: {
  provider?: string;
  nameSurface: CommandNameSurface;
}): CommandEntry[] {
  const pluginTextSpecs = listPluginCommands();
  const pluginNativeSpecs = getPluginCommandSpecs(params.provider);
  const entries: CommandEntry[] = [];

  for (const [index, textSpec] of pluginTextSpecs.entries()) {
    const nativeSpec = pluginNativeSpecs[index];
    const nativeName = nativeSpec?.name;
    entries.push({
      name: params.nameSurface === "text" ? textSpec.name : (nativeName ?? textSpec.name),
      ...(nativeName ? { nativeName } : {}),
      textAliases: [`/${textSpec.name}`],
      description: textSpec.description,
      source: "plugin",
      scope: "both",
      acceptsArgs: textSpec.acceptsArgs,
    });
  }

  if (params.nameSurface === "native") {
    return entries.filter((entry) => entry.nativeName);
  }
  return entries;
}

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

  commands.push(...buildPluginCommandEntries({ provider, nameSurface }));

  return { commands };
}

export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": ({ params, respond }) => {
    if (!validateCommandsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid commands.list params: ${formatValidationErrors(validateCommandsListParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }
    respond(
      true,
      buildCommandsListResult({
        cfg: resolved.cfg,
        agentId: resolved.agentId,
        provider: params.provider,
        scope: params.scope,
        includeArgs: params.includeArgs,
      }),
      undefined,
    );
  },
};
