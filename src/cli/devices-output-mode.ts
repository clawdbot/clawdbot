import { getMachineOutputCommandPath } from "./machine-output-argv.js";

export function isDevicesMachineOutput(argv: readonly string[]): boolean {
  const [, command] = getMachineOutputCommandPath(argv, 2);
  return command === "rotate" || command === "revoke";
}
