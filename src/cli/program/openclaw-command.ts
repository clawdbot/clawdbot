// Commander subclass that preserves the exact failing command for parse-error guidance.
import { Command, type ErrorOptions } from "commander";
import { getCommanderSubcommandFact, setCommanderErrorCommand } from "./commander-parse-facts.js";

// Commander 15 declares this help hook only in its runtime class, not its types.
// Declaring it here lets the subclass override and delegate through `super`
// instead of re-binding a captured prototype method.
declare module "commander" {
  interface Command {
    _outputHelpIfRequested(args: string[]): void;
  }
}

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
  override _outputHelpIfRequested(args: string[]): void {
    const subcommandFact = getCommanderSubcommandFact(this, args);
    if (subcommandFact?.kind === "defer") {
      return;
    }
    if (subcommandFact?.kind === "unknown") {
      this.error(`error: unknown command '${subcommandFact.name}'`, {
        code: "commander.unknownCommand",
      });
    }
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Commander 15.0.0 owns this hook name; package.json pins that exact version.
    super._outputHelpIfRequested(args);
  }
}
