// Descriptor-to-lazy-command-group adapters used by core and sub-CLI registration.
import type { Command } from "commander";

/** Descriptor for one root command placeholder. */
export type NamedCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
  parentDefaultHelp?: boolean;
};

/** Group spec that names the placeholders owned by one registrar. */
export type CommandGroupDescriptorSpec<TRegister> = {
  commandNames: readonly string[];
  register: TRegister;
};

/** Import-backed command group definition. */
export type ImportedCommandGroupDefinition<TRegisterArgs, TModule> = {
  commandNames: readonly string[];
  loadModule: () => Promise<TModule>;
  register: (module: TModule, args: TRegisterArgs) => Promise<void> | void;
};

/** Resolved group entry after descriptor lookup. */
export type ResolvedCommandGroupEntry<TDescriptor extends NamedCommandDescriptor, TRegister> = {
  placeholders: TDescriptor[];
  register: TRegister;
};

type CommandGroupEntryLike = {
  placeholders: NamedCommandDescriptor[];
  register: (program: Command) => Promise<void> | void;
};

function buildDescriptorIndex<TDescriptor extends NamedCommandDescriptor>(
  descriptors: readonly TDescriptor[],
): Map<string, TDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
}

/** Resolve named command-group specs into descriptor-backed entries. */
export function resolveCommandGroupEntries<TDescriptor extends NamedCommandDescriptor, TRegister>(
  descriptors: readonly TDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TRegister>[],
): ResolvedCommandGroupEntry<TDescriptor, TRegister>[] {
  const descriptorsByName = buildDescriptorIndex(descriptors);
  return specs.map((spec) => ({
    placeholders: spec.commandNames.map((name) => {
      const descriptor = descriptorsByName.get(name);
      if (!descriptor) {
        throw new Error(`Unknown command descriptor: ${name}`);
      }
      return descriptor;
    }),
    register: spec.register,
  }));
}

/** Build lazy command-group entries with a mapped program registrar. */
export function buildCommandGroupEntries<TRegister>(
  descriptors: readonly NamedCommandDescriptor[],
  specs: readonly CommandGroupDescriptorSpec<TRegister>[],
  mapRegister: (register: TRegister) => CommandGroupEntryLike["register"],
): CommandGroupEntryLike[] {
  return resolveCommandGroupEntries(descriptors, specs).map((entry) => ({
    placeholders: entry.placeholders,
    register: mapRegister(entry.register),
  }));
}

/** Define a lazy group that imports its module at registration time. */
export function defineImportedCommandGroupSpec<TRegisterArgs, TModule>(
  commandNames: readonly string[],
  loadModule: () => Promise<TModule>,
  register: (module: TModule, args: TRegisterArgs) => Promise<void> | void,
): CommandGroupDescriptorSpec<(args: TRegisterArgs) => Promise<void>> {
  return {
    commandNames,
    register: async (args: TRegisterArgs) => {
      const module = await loadModule();
      await register(module, args);
    },
  };
}

/** Map multiple import-backed command group definitions to lazy specs. */
export function defineImportedCommandGroupSpecs<TRegisterArgs, TModule>(
  definitions: readonly ImportedCommandGroupDefinition<TRegisterArgs, TModule>[],
): CommandGroupDescriptorSpec<(args: TRegisterArgs) => Promise<void>>[] {
  return definitions.map((definition) =>
    defineImportedCommandGroupSpec(
      definition.commandNames,
      definition.loadModule,
      definition.register,
    ),
  );
}

type ProgramCommandRegistrar = (program: Command) => Promise<void> | void;
type AnyImportedProgramCommandGroupDefinition = {
  commandNames: readonly string[];
  loadModule: () => Promise<Record<string, unknown>>;
  exportName: string;
};

export type ImportedProgramCommandGroupDefinition<
  TModule extends Record<TKey, ProgramCommandRegistrar>,
  TKey extends keyof TModule & string,
> = {
  commandNames: readonly string[];
  loadModule: () => Promise<TModule>;
  exportName: TKey;
};

/** Define a program-level command group from a module export name. */
export function defineImportedProgramCommandGroupSpec<
  TModule extends Record<TKey, ProgramCommandRegistrar>,
  TKey extends keyof TModule & string,
>(
  definition: ImportedProgramCommandGroupDefinition<TModule, TKey>,
): CommandGroupDescriptorSpec<(program: Command) => Promise<void>> {
  return defineImportedCommandGroupSpec(
    definition.commandNames,
    definition.loadModule,
    (module, program: Command) => module[definition.exportName](program),
  );
}

/** Map program-level imported command definitions to lazy specs with export validation. */
export function defineImportedProgramCommandGroupSpecs(
  definitions: readonly AnyImportedProgramCommandGroupDefinition[],
): CommandGroupDescriptorSpec<(program: Command) => Promise<void>>[] {
  return definitions.map((definition) => ({
    commandNames: definition.commandNames,
    register: async (program: Command) => {
      const module = await definition.loadModule();
      const register = module[definition.exportName];
      if (typeof register !== "function") {
        throw new Error(`Missing program command registrar: ${definition.exportName}`);
      }
      await register(program);
    },
  }));
}
