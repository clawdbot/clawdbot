// Commander subclass that preserves the exact failing command for parse-error guidance.
import { Command, type ErrorOptions } from "commander";
import { getCommanderSubcommandFact, setCommanderErrorCommand } from "./commander-parse-facts.js";

type CommanderHelpInternals = Command & {
  _outputHelpIfRequested(args: string[]): void;
};

/* oxlint-disable eslint/no-underscore-dangle -- The identifier is Commander 15.0.0's own hook name; package.json pins that exact version. */
/* oxlint-disable typescript/unbound-method -- Commander omits the hook from its types; the call site restores the receiver. */
// SAFETY: Commander 15.0.0's runtime class defines this pinned private hook with the signature exposed above.
const commanderOutputHelpIfRequested = (Command.prototype as CommanderHelpInternals)
  ._outputHelpIfRequested;
/* oxlint-enable typescript/unbound-method */
/* oxlint-enable eslint/no-underscore-dangle */

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
