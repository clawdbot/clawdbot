import type { MachineOutputResolverParams } from "./machine-output-argv.js";
import { hasMachineOutputOption } from "./machine-output-argv.js";

/** Doctor lint follows Unix convention and emits JSON when stdout is not a terminal. */
export function isDoctorMachineOutput(params: MachineOutputResolverParams): boolean {
  return (
    hasMachineOutputOption(params.argv, "--lint") &&
    (hasMachineOutputOption(params.argv, "--json") || !params.stdoutIsTTY)
  );
}
