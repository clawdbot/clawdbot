import type { Command } from "commander";
import { reparseProgramFromActionArgs } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";

type RegisterLazyCommandParams = {
  program: Command;
  name: string;
  description: string;
  options?: readonly {
    flags: string;
    description: string;
  }[];
  removeNames?: string[];
  register: () => Promise<void> | void;
};

function resolvePlaceholderOptionArgs(command: Command): string[] {
  const out: string[] = [];
  for (const option of command.options) {
    const value = command.getOptionValue(option.attributeName());
    if (value === undefined || value === false) {
      continue;
    }
    const flag = option.long ?? option.short;
    if (!flag) {
      continue;
    }
    out.push(flag);
    if (value !== true) {
      out.push(String(value));
    }
  }
  return out;
}

export function registerLazyCommand({
  program,
  name,
  description,
  options,
  removeNames,
  register,
}: RegisterLazyCommandParams): void {
  const placeholder = program.command(name).description(description);
  for (const option of options ?? []) {
    placeholder.option(option.flags, option.description);
  }
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    const actionCommand = actionArgs.at(-1) as (Command & { args?: string[] }) | undefined;
    if (actionCommand) {
      actionCommand.args = [
        ...resolvePlaceholderOptionArgs(actionCommand),
        ...(actionCommand.args ?? []),
      ];
    }
    for (const commandName of new Set(removeNames ?? [name])) {
      removeCommandByName(program, commandName);
    }
    await register();
    await reparseProgramFromActionArgs(program, actionArgs);
  });
}
