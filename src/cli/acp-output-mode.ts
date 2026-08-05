import { getMachineOutputCommandPath } from "./machine-output-argv.js";

/** Reserve stdout for the unconditional JSON emitted by `openclaw acp info`. */
export function isAcpMachineOutput(argv: readonly string[]): boolean {
  const [root, command] = getMachineOutputCommandPath(argv, 2);
  return root === "acp" && command === "info";
}
