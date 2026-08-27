/** Validates argument boundaries for explicitly invoked native session directives. */
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/** Rejects prose left over after canonical command-specific validation succeeds. */
export function maybeHandleUnexpectedNativeDirectiveArguments(
  directives: InlineDirectives,
): ReplyPayload | undefined {
  const nativeCommand = directives.nativeCommand;
  const unconsumedArguments = nativeCommand?.unconsumedArguments;
  if (!nativeCommand || !unconsumedArguments) {
    return undefined;
  }

  // One token is enough to explain the rejected boundary without echoing an unbounded prompt.
  const unexpectedArgument = unconsumedArguments.split(/\s+/, 1)[0] ?? unconsumedArguments;
  return {
    text: `Unexpected argument "${unexpectedArgument}" for /${nativeCommand.name}.`,
  };
}
