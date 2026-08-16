// Commander subclass that preserves the exact failing command for parse-error guidance.
import { Command, type ErrorOptions } from "commander";
import { setCommanderErrorCommand } from "./commander-parse-facts.js";

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
}
