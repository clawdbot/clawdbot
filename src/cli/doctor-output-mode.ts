import type { MachineOutputResolverParams } from "./machine-output-argv.js";
import { hasMachineOutputOption } from "./machine-output-argv.js";

/** Bare doctor JSON and non-TTY lint runs own machine-readable stdout. */
export function isDoctorMachineOutput(params: MachineOutputResolverParams): boolean {
  const lint = hasMachineOutputOption(params.argv, "--lint");
  if (lint) {
    return hasMachineOutputOption(params.argv, "--json") || !params.stdoutIsTTY;
  }
  const existingMachineMode =
    hasMachineOutputOption(params.argv, "--post-upgrade") ||
    hasMachineOutputOption(params.argv, "--state-sqlite") ||
    hasMachineOutputOption(params.argv, "--session-sqlite");
  return hasMachineOutputOption(params.argv, "--json") && !existingMachineMode;
}
