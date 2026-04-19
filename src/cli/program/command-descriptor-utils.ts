import type { Command } from "commander";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

export type CommandDescriptorLike = Pick<NamedCommandDescriptor, "name" | "description">;

export type CommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor> = {
  descriptors: readonly TDescriptor[];
  getDescriptors: () => readonly TDescriptor[];
  getNames: () => string[];
  getCommandsWithSubcommands: () => string[];
};

export function getCommandDescriptorNames(descriptors: readonly CommandDescriptorLike[]): string[] {
  return descriptors.map((descriptor) => descriptor.name);
}

export function getCommandsWithSubcommands(
  descriptors: readonly NamedCommandDescriptor[],
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.hasSubcommands)
    .map((descriptor) => descriptor.name);
}

export function collectUniqueCommandDescriptors<TDescriptor extends CommandDescriptorLike>(
  descriptorGroups: readonly (readonly TDescriptor[])[],
): TDescriptor[] {
  const seen = new Set<string>();
  const descriptors: TDescriptor[] = [];
  for (const group of descriptorGroups) {
    for (const descriptor of group) {
      if (seen.has(descriptor.name)) {
        continue;
      }
      seen.add(descriptor.name);
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

export function defineCommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor>(
  descriptors: readonly TDescriptor[],
): CommandDescriptorCatalog<TDescriptor> {
  return {
    descriptors,
    getDescriptors: () => descriptors,
    getNames: () => getCommandDescriptorNames(descriptors),
    getCommandsWithSubcommands: () => getCommandsWithSubcommands(descriptors),
  };
}

export function addCommandDescriptorsToProgram(
  program: Command,
  descriptors: readonly CommandDescriptorLike[],
  existingCommands: Set<string> = new Set(),
): Set<string> {
  for (const descriptor of descriptors) {
    if (existingCommands.has(descriptor.name)) {
      continue;
    }
    program.command(descriptor.name).description(descriptor.description);
    existingCommands.add(descriptor.name);
  }
  return existingCommands;
}
