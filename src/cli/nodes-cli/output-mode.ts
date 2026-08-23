import { getMachineOutputCommandPath } from "../machine-output-argv.js";

export function isNodesMachineOutput(argv: readonly string[]): boolean {
  const [, command] = getMachineOutputCommandPath(argv, 2);
  return command === "invoke" || command === "approve" || command === "reject";
}
