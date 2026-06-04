// Utilities for defining safe Commander placeholder descriptors and descriptor catalogs.
import type { Command } from "commander";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

/** Minimal descriptor shape used before a command is fully registered. */
export type CommandDescriptorLike = Pick<NamedCommandDescriptor, "name" | "description">;

const SAFE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Descriptor catalog plus derived name lists used by lazy command registration. */
export type CommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor> = {
  descriptors: readonly TDescriptor[];
  getDescriptors: () => readonly TDescriptor[];
  getNames: () => string[];
  getCommandsWithSubcommands: () => string[];
  getParentDefaultHelpCommands: () => string[];
};

/** Normalize and validate a command descriptor name for safe Commander registration. */
export function normalizeCommandDescriptorName(name: string): string | null {
  const normalized = name.trim();
  return SAFE_COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

function assertSafeCommandDescriptorName(name: string): string {
  const normalized = normalizeCommandDescriptorName(name);
  if (!normalized) {
    throw new Error(`Invalid CLI command name: ${JSON.stringify(name.trim())}`);
  }
  return normalized;
}

/** Strip unsafe terminal content from descriptor descriptions. */
export function sanitizeCommandDescriptorDescription(description: string): string {
  return sanitizeForLog(description).trim();
}

/** Return descriptor names in registration order. */
export function getCommandDescriptorNames(descriptors: readonly CommandDescriptorLike[]): string[] {
  return descriptors.map((descriptor) => descriptor.name);
}

/** Return descriptor names that should remain parent commands with subcommands. */
export function getCommandsWithSubcommands(
  descriptors: readonly NamedCommandDescriptor[],
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.hasSubcommands)
    .map((descriptor) => descriptor.name);
}

/** Return descriptors whose parent command should show help by default. */
export function getParentDefaultHelpCommands(
  descriptors: readonly NamedCommandDescriptor[],
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.parentDefaultHelp)
    .map((descriptor) => descriptor.name);
}

/** Merge descriptor groups while keeping the first descriptor for each command name. */
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

/** Create a descriptor catalog with stable derived lists. */
export function defineCommandDescriptorCatalog<TDescriptor extends NamedCommandDescriptor>(
  descriptors: readonly TDescriptor[],
): CommandDescriptorCatalog<TDescriptor> {
  return {
    descriptors,
    getDescriptors: () => descriptors,
    getNames: () => getCommandDescriptorNames(descriptors),
    getCommandsWithSubcommands: () => getCommandsWithSubcommands(descriptors),
    getParentDefaultHelpCommands: () => getParentDefaultHelpCommands(descriptors),
  };
}

/** Add safe placeholder commands to Commander without duplicating existing command names. */
export function addCommandDescriptorsToProgram(
  program: Command,
  descriptors: readonly CommandDescriptorLike[],
  existingCommands: Set<string> = new Set(),
): Set<string> {
  for (const descriptor of descriptors) {
    const name = assertSafeCommandDescriptorName(descriptor.name);
    if (existingCommands.has(name)) {
      continue;
    }
    program.command(name).description(sanitizeCommandDescriptorDescription(descriptor.description));
    existingCommands.add(name);
  }
  return existingCommands;
}
