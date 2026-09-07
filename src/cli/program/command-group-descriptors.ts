// Descriptor-to-lazy-command-group adapters used by core and sub-CLI registration.
import type { Command } from "commander";
import type { MachineOutputResolver } from "../machine-output-argv.js";

/** Descriptor for one root command placeholder. */
export type NamedCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
  machineOutput?: MachineOutputResolver;
  hidden?: boolean;
  parentDefaultHelp?: boolean;
};

/** Command names owned by one lazy registrar. */
export type CommandGroupDescriptorSpec<TArgs extends unknown[] = []> = readonly [
  commandNames: readonly string[],
  register: (program: Command, ...args: TArgs) => Promise<void> | void,
];

type CommandGroupEntryLike = {
  placeholders: NamedCommandDescriptor[];
  register: (program: Command) => Promise<void> | void;
};

/** Bind descriptors and registration arguments without importing the command modules. */
export function buildCommandGroupEntries<TArgs extends unknown[]>(
  descriptors: readonly NamedCommandDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TArgs>[],
  ...args: TArgs
): CommandGroupEntryLike[] {
  const descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return specs.map(([commandNames, register]) => ({
    placeholders: commandNames.map((name) => {
      const descriptor = descriptorsByName.get(name);
      if (!descriptor) {
        throw new Error(`Unknown command descriptor: ${name}`);
      }
      return descriptor;
    }),
    register: (program) => register(program, ...args),
  }));
}
