import { getMachineOutputCommandPath } from "../machine-output-argv.js";

const MACHINE_OUTPUT_COMMANDS = new Set([
  "add",
  "create",
  "delete",
  "disable",
  "edit",
  "enable",
  "get",
  "remove",
  "rm",
  "run",
  "runs",
  "status",
]);

export function isCronMachineOutput(argv: readonly string[]): boolean {
  const [, command] = getMachineOutputCommandPath(argv, 2);
  if (!command) {
    return false;
  }
  if (MACHINE_OUTPUT_COMMANDS.has(command)) {
    return true;
  }
  return command === "scratch";
}
