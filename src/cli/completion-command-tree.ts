import type { Command, Option } from "commander";

export type ShellCompletionContext = {
  command: Command;
  pathVariants: string[][];
  completions: string[];
  valueOptions: string[];
};

type ShellCompletionCommandTree = {
  root: ShellCompletionContext;
  descendants: ShellCompletionContext[];
};

function completionFlags(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => Boolean(flag));
}

function commandNameVariants(command: Command): string[] {
  return [command.name(), ...command.aliases()];
}

export function collectShellCompletionCommandTree(program: Command): ShellCompletionCommandTree {
  const descendants: ShellCompletionContext[] = [];

  const visit = (
    command: Command,
    pathVariants: string[][],
    inheritedValueOptions: readonly string[],
  ): ShellCompletionContext => {
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
      );
    }

    return context;
  };

  return { root: visit(program, [[]], []), descendants };
}
