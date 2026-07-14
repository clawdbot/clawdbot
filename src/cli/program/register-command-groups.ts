// Lazy command-group registration: placeholder commands are replaced by real subcommand groups.
import type { Command } from "commander";
import { removeCommandByName } from "./command-tree.js";
import { registerLazyCommand } from "./register-lazy-command.js";

/** Placeholder command shown before its lazy group is loaded. */
export type CommandGroupPlaceholder = {
  name: string;
  description: string;
  options?: readonly CommandGroupPlaceholderOption[];
};

/** Commander option metadata attached to a lazy placeholder. */
type CommandGroupPlaceholderOption = {
  flags: string;
  description: string;
};

/** A lazily registered command group and the names it owns. */
export type CommandGroupEntry = {
  placeholders: readonly CommandGroupPlaceholder[];
  names?: readonly string[];
  register: (program: Command) => Promise<void> | void;
};

/** Return every command name owned by a lazy command group. */
export function getCommandGroupNames(entry: CommandGroupEntry): readonly string[] {
  return entry.names ?? entry.placeholders.map((placeholder) => placeholder.name);
}

/** Find the group that owns a command name. */
export function findCommandGroupEntry(
  entries: readonly CommandGroupEntry[],
  name: string,
): CommandGroupEntry | undefined {
  return entries.find((entry) => getCommandGroupNames(entry).includes(name));
}

/** Remove all placeholder/loaded commands owned by a group before replacing it. */
export function removeCommandGroupNames(program: Command, entry: CommandGroupEntry) {
  for (const name of new Set(getCommandGroupNames(entry))) {
    removeCommandByName(program, name);
  }
}

/** Eagerly register one lazy command group by command name. */
export async function registerCommandGroupByName(
  program: Command,
  entries: readonly CommandGroupEntry[],
  name: string,
): Promise<boolean> {
  const entry = findCommandGroupEntry(entries, name);
  if (!entry) {
    return false;
  }
  removeCommandGroupNames(program, entry);
  await entry.register(program);
  return true;
}

/** Register one placeholder that loads and replaces its whole command group on demand. */
export function registerLazyCommandGroup(
  program: Command,
  entry: CommandGroupEntry,
  placeholder: CommandGroupPlaceholder,
) {
  registerLazyCommand({
    program,
    name: placeholder.name,
    description: placeholder.description,
    options: placeholder.options,
    removeNames: getCommandGroupNames(entry),
    register: () => entry.register(program),
  });
}

/** Register command groups either eagerly or as lazy placeholders for startup speed. */
export function registerCommandGroups(
  program: Command,
  entries: readonly CommandGroupEntry[],
  params: {
    eager: boolean;
    primary: string | null;
    registerPrimaryOnly: boolean;
  },
) {
  if (params.eager) {
    for (const entry of entries) {
      void entry.register(program);
    }
    return;
  }

  if (params.primary && params.registerPrimaryOnly) {
    const entry = findCommandGroupEntry(entries, params.primary);
    if (entry) {
      const placeholder = entry.placeholders.find((candidate) => candidate.name === params.primary);
      if (placeholder) {
        registerLazyCommandGroup(program, entry, placeholder);
      }
      return;
    }
  }

  for (const entry of entries) {
    for (const placeholder of entry.placeholders) {
      registerLazyCommandGroup(program, entry, placeholder);
    }
  }
}
