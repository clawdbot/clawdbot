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
    const registerEntry = async () => {
      await entry.register(program);
      for (const command of getCommandGroupNames(entry)) {
        params.existingCommands.add(command);
      }
    };

    if (params.primary && findCommandGroupEntry([entry], params.primary)) {
      removeCommandGroupNames(program, entry);
      await registerEntry();
      continue;
    }

    const overlaps = getCommandGroupNames(entry).filter((command) =>
      params.existingCommands.has(command),
    );
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
          registerLazyCommandGroup(program, entry, placeholder);
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
