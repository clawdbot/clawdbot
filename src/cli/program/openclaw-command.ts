// Commander subclass that preserves the exact failing command for parse-error guidance.
import { Command, type ErrorOptions } from "commander";
import { setCommanderErrorCommand } from "./commander-parse-facts.js";

export class OpenClawCommand extends Command {
  override createCommand(name?: string): Command {
    return new OpenClawCommand(name);
  }

  override error(message: string, errorOptions?: ErrorOptions): never {
    const firstArgument = this.args[0];
    // Commander checks a parent action before its unknown-command branch.
    // Reclassify only zero-argument parents so genuine leaf excess stays intact.
    const isUnknownSubcommand =
      errorOptions?.code === "commander.excessArguments" &&
      this.registeredArguments.length === 0 &&
      this.commands.length > 0 &&
      firstArgument !== undefined &&
      !this.commands.some(
        (command) => command.name() === firstArgument || command.aliases().includes(firstArgument),
      );
    const restoreErrorCommand = setCommanderErrorCommand(this);
    try {
      return super.error(
        isUnknownSubcommand ? `error: unknown command '${firstArgument}'` : message,
        isUnknownSubcommand ? { ...errorOptions, code: "commander.unknownCommand" } : errorOptions,
      );
    } finally {
      restoreErrorCommand();
    }
  }
}
