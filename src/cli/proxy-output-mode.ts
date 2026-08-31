import { getMachineOutputCommandPath } from "./machine-output-argv.js";

const MACHINE_OUTPUT_COMMANDS = new Set(["blob", "coverage", "purge", "query", "sessions"]);

/** Proxy inspection commands reserve stdout for JSON or raw captured content. */
export function isProxyMachineOutput(argv: readonly string[]): boolean {
  const [, command] = getMachineOutputCommandPath(argv, 2);
  return MACHINE_OUTPUT_COMMANDS.has(command ?? "");
}
