import { fileURLToPath } from "node:url";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { run } from "./host-command.ts";
import type { CommandResult, RunOptions } from "./types.ts";

export function resolveMacosPrlctlInvocation(
  command: string,
  args: string[],
  timeoutMs?: number,
): { command: string; args: string[] } {
  if (
    command !== "prlctl" ||
    args[0] !== "exec" ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  ) {
    return { command, args };
  }
  // Select before execution: an SDK failure must never replay a guest command.
  // The client verifies the installed binary; other versions retain prlctl.
  const timeoutArgs =
    timeoutMs === undefined ? [] : ["--timeout-ms", String(clampTimerTimeoutMs(timeoutMs) ?? 1)];
  return {
    command: "python3",
    args: [
      "-B",
      fileURLToPath(new URL("./parallels-exec.py", import.meta.url)),
      ...timeoutArgs,
      "--",
      ...args,
    ],
  };
}

export function runMacosHostCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): CommandResult {
  const invocation = resolveMacosPrlctlInvocation(command, args, options.timeoutMs);
  return run(invocation.command, invocation.args, options);
}
