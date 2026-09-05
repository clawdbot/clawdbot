import { consumeRootOptionToken, findRootCommandIndex } from "../infra/cli-root-options.js";

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
  const rootIndex = findRootCommandIndex(argv);
  if (rootIndex === null) {
    return null;
  }
  for (let index = rootIndex + 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      return null;
    }
    const rootConsumed = consumeRootOptionToken(argv, index);
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

/** Config values, paths, and schemas reserve stdout for machine-consumed output. */
export function isConfigMachineOutput(argv: readonly string[]): boolean {
  const subcommand = resolveConfigSubcommand(argv);
  return subcommand === "get" || subcommand === "file" || subcommand === "schema";
}

/** Config set uses --json as a parser alias except when dry-run emits a JSON report. */
export function isConfigSetJsonParseOnly(argv: readonly string[]): boolean {
  return hasFlag(argv, "--json") && !hasFlag(argv, "--dry-run");
}
