import type { Command, Option } from "commander";

type ShellCompletionValueChoice = {
  flags: string[];
  choices: string[];
  requiresValue: boolean;
};

export type ShellCompletionContext = {
  command: Command;
  pathVariants: string[][];
  completions: string[];
  valueOptions: string[];
  valueChoices: ShellCompletionValueChoice[];
};

type ShellCompletionCommandTree = {
  root: ShellCompletionContext;
  descendants: ShellCompletionContext[];
};

export function completionFlags(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => Boolean(flag));
}

// Aliases are typeable command words; every completion surface must offer them
// alongside the canonical name or advertised commands appear nonexistent.
export function commandNameVariants(command: Command): string[] {
  return [command.name(), ...command.aliases()];
}

export function collectShellCompletionCommandTree(program: Command): ShellCompletionCommandTree {
  const descendants: ShellCompletionContext[] = [];

  const visit = (
    command: Command,
    pathVariants: string[][],
    inheritedValueOptions: readonly string[],
    inheritedValueChoices: readonly ShellCompletionValueChoice[],
  ): ShellCompletionContext => {
    const ownOptionFlags = new Set(command.options.flatMap(completionFlags));
    const context: ShellCompletionContext = {
      command,
      pathVariants,
      completions: [
        ...command.commands.flatMap(commandNameVariants),
        ...command.options.flatMap(completionFlags),
      ],
      valueOptions: [
        ...new Set([
          ...inheritedValueOptions,
          ...command.options.flatMap((option) =>
            option.required || option.optional ? completionFlags(option) : [],
          ),
        ]),
      ],
      valueChoices: [
        ...inheritedValueChoices.flatMap(({ flags, ...choice }) => {
          const inheritedFlags = flags.filter((flag) => !ownOptionFlags.has(flag));
          return inheritedFlags.length > 0 ? [{ flags: inheritedFlags, ...choice }] : [];
        }),
        ...command.options.flatMap((option) =>
          option.argChoices?.length
            ? [
                {
                  flags: completionFlags(option),
                  choices: [...option.argChoices],
                  requiresValue: option.required,
                },
              ]
            : [],
        ),
      ],
    };

    if (pathVariants[0]?.length) {
      descendants.push(context);
    }

    for (const child of command.commands) {
      visit(
        child,
        pathVariants.flatMap((parents) =>
          commandNameVariants(child).map((name) => parents.concat(name)),
        ),
        context.valueOptions,
        context.valueChoices,
      );
    }

    return context;
  };

  return { root: visit(program, [[]], [], []), descendants };
}
