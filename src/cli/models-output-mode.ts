import { resolveCliStartupCommandPath } from "./argv-invocation.js";
import { hasMachineOutputOption } from "./machine-output-argv.js";

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[]): boolean {
  return (
    hasMachineOutputOption(argv, "--json") ||
    (resolveCliStartupCommandPath([...argv]).length === 1 &&
      hasMachineOutputOption(argv, "--status-json"))
  );
}
