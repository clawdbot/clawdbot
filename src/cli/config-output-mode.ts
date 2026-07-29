import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import { findMachineOutputRootCommandIndex } from "./machine-output-argv.js";

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

function resolveConfigSubcommand(argv: readonly string[]): string | null {
  const rootIndex = findMachineOutputRootCommandIndex(argv);
  if (rootIndex === null) {
    return null;
  }
  const args = argv.slice(2);
  for (let index = rootIndex - 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return null;
    }
    const rootConsumed = consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    if (arg === "--section") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--section=")) {
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return null;
}

/** Config get reserves stdout for the requested value, including bare scalar output. */
export function isConfigMachineOutput(argv: readonly string[]): boolean {
  return resolveConfigSubcommand(argv) === "get";
}

/** Config set uses --json as a parser alias except when dry-run emits a JSON report. */
export function isConfigSetJsonParseOnly(argv: readonly string[]): boolean {
  return hasFlag(argv, "--json") && !hasFlag(argv, "--dry-run");
}
