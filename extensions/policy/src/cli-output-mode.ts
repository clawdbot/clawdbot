import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

/** Policy commands follow Unix convention and switch to JSON when stdout is not a terminal. */
function isPolicyMachineOutput(params: { argv: readonly string[]; stdoutIsTTY: boolean }): boolean {
  const [, command] = getRootOptionAwareCommandPath(params.argv, 2);
  return ["check", "compare", "watch"].includes(command ?? "") && !params.stdoutIsTTY;
}

export const POLICY_CLI_DESCRIPTOR = {
  name: "policy",
  description: "Check policy requirements and emit audit evidence",
  hasSubcommands: true,
  machineOutput: isPolicyMachineOutput,
} as const;
