import { getMachineOutputCommandPath } from "./machine-output-argv.js";

/** Agent database rehearsals always reserve stdout for the JSON contract. */
export function isAgentsMachineOutput(argv: readonly string[]): boolean {
  const [, command] = getMachineOutputCommandPath(argv, 2);
  return command === "db-rehearsal";
}
