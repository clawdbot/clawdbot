import {
  consumeRootOptionToken,
  getRootOptionAwareCommandPath,
} from "../infra/cli-root-options.js";

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

/** Locate the root command after supported root options without loading descriptor catalogs. */
export function findMachineOutputRootCommandIndex(argv: readonly string[]): number | null {
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return null;
    }
    const consumed = consumeRootOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return index + 2;
  }
  return null;
}

/** Read positional command tokens after supported root options, without importing CLI catalogs. */
export function getMachineOutputCommandPath(argv: readonly string[], depth: number): string[] {
  return getRootOptionAwareCommandPath(argv, depth);
}

/** Match a boolean or value option before the argv terminator, including `--flag=value`. */
export function hasMachineOutputOption(argv: readonly string[], flag: string): boolean {
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
