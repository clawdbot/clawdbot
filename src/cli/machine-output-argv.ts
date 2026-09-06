import type { Command } from "commander";
import { getRootOptionAwareCommandPath } from "../infra/cli-root-options.js";
import { hasCommanderOptionToken } from "./program/commander-parse-facts.js";

export type MachineOutputResolverParams = {
  argv: readonly string[];
  stdoutIsTTY: boolean;
};

export type MachineOutputResolver = (params: MachineOutputResolverParams) => boolean;

export const MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION =
  "Explicit machine-output spelling (command results are JSON by default)";

/** Normalize Node's absent `isTTY` property to the public resolver's boolean contract. */
export function isMachineOutputStdoutTTY(
  stdout: { readonly isTTY?: boolean } = process.stdout,
): boolean {
  return stdout.isTTY === true;
}

/** Read positional command tokens after supported root options, without importing CLI catalogs. */
export function getMachineOutputCommandPath(argv: readonly string[], depth: number): string[] {
  return getRootOptionAwareCommandPath(argv, depth);
}

/** Prefer registered option roles; early discovery falls back to literal option spellings. */
export function hasMachineOutputOption(
  argv: readonly string[],
  flag: string,
  command?: Command,
): boolean {
  if (command) {
    return hasCommanderOptionToken(command, argv, new Set([flag]), "flag");
  }
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      return false;
    }
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      return true;
    }
  }
  return false;
}
