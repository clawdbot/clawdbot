import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveModelsParentCommandPath } from "./parent-command-path.js";

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[]): boolean {
  return (
    hasMachineOutputOption(argv, "--json") ||
    (resolveModelsParentCommandPath(argv)?.length === 1 &&
      hasMachineOutputOption(argv, "--status-json"))
  );
}
