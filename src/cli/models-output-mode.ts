import type { Command } from "commander";
import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveCliParentCommandPath } from "./parent-command-path.js";

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[], command?: Command): boolean {
  return (
    hasMachineOutputOption(argv, "--json", command) ||
    (resolveCliParentCommandPath(argv, "models")?.length === 1 &&
      hasMachineOutputOption(argv, "--status-json", command))
  );
}

export function isModelsPlainMachineOutput(argv: readonly string[], command?: Command): boolean {
  const commandPath = resolveCliParentCommandPath(argv, "models");
  return (
    commandPath !== null &&
    (hasMachineOutputOption(argv, "--plain", command) ||
      (commandPath.length === 1 && hasMachineOutputOption(argv, "--status-plain", command)))
  );
}
