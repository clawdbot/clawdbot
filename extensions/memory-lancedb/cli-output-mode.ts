import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

/** LanceDB inspection commands emit JSON as their only presentation. */
export function isMemoryMachineOutput(params: { argv: readonly string[] }): boolean {
  const [, command] = getRootOptionAwareCommandPath(params.argv, 2);
  return ["list", "query", "search"].includes(command ?? "");
}
