import type { RunResult } from "./invoke-types.js";
import "./invoke.js";

type NodeHostInvokeTestApi = {
  clarifyNodeExecCwdSpawnError(error: NodeJS.ErrnoException, cwd: string | undefined): string;
  runCommand(
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<RunResult>;
};

function getTestApi(): NodeHostInvokeTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.nodeHostInvokeTestApi")
  ] as NodeHostInvokeTestApi;
}

export const testing: NodeHostInvokeTestApi = {
  clarifyNodeExecCwdSpawnError(error, cwd) {
    return getTestApi().clarifyNodeExecCwdSpawnError(error, cwd);
  },
  runCommand(argv, cwd, env, timeoutMs, signal) {
    return getTestApi().runCommand(argv, cwd, env, timeoutMs, signal);
  },
};
