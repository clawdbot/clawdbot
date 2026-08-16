// Commander subclass that preserves the exact failing command for parse-error guidance.
import { Command, type ErrorOptions } from "commander";
import { getCommanderSubcommandFact, setCommanderErrorCommand } from "./commander-parse-facts.js";

type CommanderHelpInternals = Command & {
  _outputHelpIfRequested(args: string[]): void;
};

// SAFETY: Commander 15 owns this prototype method; the adapter preserves its receiver and args.
const commanderOutputHelpIfRequested = (Command.prototype as CommanderHelpInternals)
  ._outputHelpIfRequested;

export class OpenClawCommand extends Command {
  override createCommand(name?: string): Command {
    return new OpenClawCommand(name);
  }

  override error(message: string, errorOptions?: ErrorOptions): never {
    const restoreErrorCommand = setCommanderErrorCommand(this);
    try {
      return super.error(message, errorOptions);
    } finally {
      restoreErrorCommand();
    }
  }

  // Commander 15 checks this internal hook before dispatching actions.
  // Defer only marked lazy placeholders so their real command tree can decide.
  _outputHelpIfRequested(args: string[]): void {
    const subcommandFact = getCommanderSubcommandFact(this, args);
    if (subcommandFact?.kind === "defer") {
      return;
    }
    if (subcommandFact?.kind === "unknown") {
      this.error(`error: unknown command '${subcommandFact.name}'`, {
        code: "commander.unknownCommand",
      });
    }
    commanderOutputHelpIfRequested.call(this, args);
  }
}
