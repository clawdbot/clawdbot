import { resolveCliParentCommandPath } from "./parent-command-path.js";

function hasFlag(argv: readonly string[], flag: string): boolean {
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      return false;
    }
    if (arg === flag) {
      return true;
    }
  }
  return false;
}

/** Config values, paths, and schemas reserve stdout for machine-consumed output. */
export function isConfigMachineOutput(argv: readonly string[]): boolean {
  const subcommand = resolveCliParentCommandPath(argv, "config")?.[1];
  return subcommand === "get" || subcommand === "file" || subcommand === "schema";
}

/** Config set uses --json as a parser alias except when dry-run emits a JSON report. */
export function isConfigSetJsonParseOnly(argv: readonly string[]): boolean {
  return hasFlag(argv, "--json") && !hasFlag(argv, "--dry-run");
}
