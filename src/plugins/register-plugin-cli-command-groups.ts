import type { Command } from "commander";
import {
  findCommandGroupEntry,
  getCommandGroupNames,
  registerLazyCommandGroup,
  removeCommandGroupNames,
  type CommandGroupEntry,
} from "../cli/program/register-command-groups.js";
import type { OpenClawPluginCliCommandDescriptor, PluginLogger } from "./types.js";

export type PluginCliCommandGroupEntry = CommandGroupEntry & {
  pluginId: string;
  parentPath?: readonly string[];
};

export type PluginCliCommandGroupMode = "eager" | "lazy";

function canRegisterPluginCliLazily(entry: PluginCliCommandGroupEntry): boolean {
  if (entry.placeholders.length === 0) {
    return false;
  }
  const descriptorNames = new Set(
    (entry.placeholders as readonly OpenClawPluginCliCommandDescriptor[]).map(
      (descriptor) => descriptor.name,
    ),
  );
  return getCommandGroupNames(entry).every((command) => descriptorNames.has(command));
}

function findCommandByPath(program: Command, path: readonly string[]): Command | null {
  let current = program;
  for (const segment of path) {
    const next = current.commands.find(
      (command) => command.name() === segment || command.aliases().includes(segment),
    );
    if (!next) {
      return null;
    }
    current = next;
  }
  return current;
}

function commandNamesFor(program: Command): Set<string> {
  return new Set(program.commands.flatMap((command) => [command.name(), ...command.aliases()]));
}

export async function registerPluginCliCommandGroups(
  program: Command,
  entries: readonly PluginCliCommandGroupEntry[],
  params: {
    mode: PluginCliCommandGroupMode;
    primary?: string;
    existingCommands: Set<string>;
    logger: PluginLogger;
  },
) {
  for (const entry of entries) {
    const parentPath = entry.parentPath ?? [];
    const targetProgram = findCommandByPath(program, parentPath);
    if (!targetProgram) {
      params.logger.debug?.(
        `plugin CLI register skipped (${entry.pluginId}): parent command missing (${parentPath.join(
          " ",
        )})`,
      );
      continue;
    }
    const existingCommands =
      parentPath.length === 0 ? params.existingCommands : commandNamesFor(targetProgram);
    const registerEntry = async () => {
      await entry.register(targetProgram);
      for (const command of getCommandGroupNames(entry)) {
        existingCommands.add(command);
      }
    };

    if (
      params.primary &&
      (parentPath[0] === params.primary || findCommandGroupEntry([entry], params.primary))
    ) {
      removeCommandGroupNames(targetProgram, entry);
      await registerEntry();
      continue;
    }

    const overlaps = getCommandGroupNames(entry).filter((command) => existingCommands.has(command));
    if (overlaps.length > 0) {
      params.logger.debug?.(
        `plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(
          ", ",
        )})`,
      );
      continue;
    }

    try {
      if (params.mode === "lazy" && canRegisterPluginCliLazily(entry)) {
        for (const placeholder of entry.placeholders) {
          registerLazyCommandGroup(targetProgram, entry, placeholder);
        }
        continue;
      }

      if (params.mode === "lazy" && entry.placeholders.length > 0) {
        params.logger.debug?.(
          `plugin CLI lazy register fallback to eager (${entry.pluginId}): descriptors do not cover all command roots`,
        );
      }
      await registerEntry();
    } catch (error) {
      params.logger.warn(`plugin CLI register failed (${entry.pluginId}): ${String(error)}`);
    }
  }
}
