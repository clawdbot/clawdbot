// Root-option forwarding helper for subcommand dispatchers that reparse argv later.
import { consumeRootOptionToken } from "../infra/cli-root-options.js";

/** Copy one consumed root option and its value tokens into `out`, returning token count. */
export function forwardConsumedCliRootOption(
  args: readonly string[],
  index: number,
  out: string[],
): number {
  const consumedRootOption = consumeRootOptionToken(args, index);
  if (consumedRootOption <= 0) {
    return 0;
  }

  for (let offset = 0; offset < consumedRootOption; offset += 1) {
    const token = args[index + offset];
    if (token !== undefined) {
      out.push(token);
    }
  }

  return consumedRootOption;
}
