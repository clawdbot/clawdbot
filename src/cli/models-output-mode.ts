import type { Command } from "commander";
import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveModelsParentCommandPath } from "./parent-command-path.js";

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[], command?: Command): boolean {
  return (
    hasMachineOutputOption(argv, "--json", command) ||
    (resolveModelsParentCommandPath(argv)?.length === 1 &&
      hasMachineOutputOption(argv, "--status-json", command))
  );
}

export function isModelsPlainMachineOutput(argv: readonly string[], command?: Command): boolean {
  const commandPath = resolveModelsParentCommandPath(argv);
  return (
    commandPath !== null &&
    (hasMachineOutputOption(argv, "--plain", command) ||
      (commandPath.length === 1 && hasMachineOutputOption(argv, "--status-plain", command)))
  );
}
