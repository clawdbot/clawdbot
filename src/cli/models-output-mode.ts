import { hasMachineOutputOption } from "./machine-output-argv.js";

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[]): boolean {
  return hasMachineOutputOption(argv, "--json") || hasMachineOutputOption(argv, "--status-json");
}
