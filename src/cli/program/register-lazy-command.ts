// Lazy Commander placeholder registration used to keep CLI startup imports small.
import type { Command } from "commander";
import { reparseProgramFromActionCommand } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";

type RegisterLazyCommandParams = {
  program: Command;
  name: string;
  description: string;
  options?: readonly {
    flags: string;
    description: string;
  }[];
  removeNames?: readonly string[];
  register: () => Promise<void> | void;
};

/** Register a placeholder that loads the real command and reparses the original invocation. */
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
  placeholder.allowUnknownOption(true).allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    const actionCommand = actionArgs.at(-1) as Command;
    for (const commandName of new Set(removeNames ?? [name])) {
      removeCommandByName(program, commandName);
    }
    await register();
    await reparseProgramFromActionCommand(program, actionCommand);
  });
}
