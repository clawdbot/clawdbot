import type { Command } from "commander";
import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveModelsParentCommandPath } from "./parent-command-path.js";
import { hasCommanderOptionToken } from "./program/commander-parse-facts.js";

function hasModelsOutputOption(argv: readonly string[], token: string, command?: Command): boolean {
  return command
    ? hasCommanderOptionToken(command, argv, new Set([token]), "flag")
    : hasMachineOutputOption(argv, token);
}

/** Resolve the parent-command alias for `models status --json`. */
export function isModelsStatusJsonOutput(argv: readonly string[], command?: Command): boolean {
  return (
    hasModelsOutputOption(argv, "--json", command) ||
    (resolveModelsParentCommandPath(argv)?.length === 1 &&
      hasModelsOutputOption(argv, "--status-json", command))
  );
}

export function isModelsPlainMachineOutput(argv: readonly string[], command?: Command): boolean {
  const commandPath = resolveModelsParentCommandPath(argv);
  return (
    commandPath !== null &&
    (hasModelsOutputOption(argv, "--plain", command) ||
      (commandPath.length === 1 && hasModelsOutputOption(argv, "--status-plain", command)))
  );
}
