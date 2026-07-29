/** Command-list assembly and config filtering for chat command registries. */
import { isCommandFlagEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillCommandSpec } from "../skills/types.js";
import { getChatCommands } from "./commands-registry.data.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

/** Builds dynamic command definitions exported by installed skills. */
function buildSkillCommandDefinitions(skillCommands?: SkillCommandSpec[]): ChatCommandDefinition[] {
  if (!skillCommands || skillCommands.length === 0) {
    return [];
  }
  return skillCommands.map((spec) => {
    const command: ChatCommandDefinition = {
      key: `skill:${spec.skillName}`,
      nativeName: spec.name,
      description: spec.description,
      textAliases: [`/${spec.name}`],
      acceptsArgs: true,
      argsParsing: "none",
      scope: "both",
      category: "tools",
    };
    if (spec.descriptionLocalizations) {
      command.descriptionLocalizations = spec.descriptionLocalizations;
    }
    return command;
  });
}

/** Lists built-in commands plus optional skill-provided commands. */
export function listChatCommands(params?: {
  skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[] {
  const commands = getChatCommands();
  if (!params?.skillCommands?.length) {
    return [...commands];
  }
  return [...commands, ...buildSkillCommandDefinitions(params.skillCommands)];
}

/** Applies config feature flags to command keys that can be operator-disabled. */
export function isCommandEnabled(cfg: OpenClawConfig, commandKey: string): boolean {
  if (commandKey === "config") {
    return isCommandFlagEnabled(cfg, "config");
  }
  if (commandKey === "mcp") {
    return isCommandFlagEnabled(cfg, "mcp");
  }
  if (commandKey === "plugins") {
    return isCommandFlagEnabled(cfg, "plugins");
  }
  if (commandKey === "debug") {
    return isCommandFlagEnabled(cfg, "debug");
  }
  if (commandKey === "bash") {
    return isCommandFlagEnabled(cfg, "bash");
  }
  return true;
}

/** Lists commands visible for a specific config, preserving dynamic skill commands. */
export function listChatCommandsForConfig(
  cfg: OpenClawConfig,
  params?: { skillCommands?: SkillCommandSpec[] },
): ChatCommandDefinition[] {
  const base = getChatCommands().filter((command) => isCommandEnabled(cfg, command.key));
  if (!params?.skillCommands?.length) {
    return base;
  }
  return [...base, ...buildSkillCommandDefinitions(params.skillCommands)];
}
