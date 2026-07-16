import type { RunResult } from "./invoke-types.js";
import "./invoke.js";

type NodeHostInvokeTestApi = {
  readonly MCP_TEXT_CONTENT_MAX_BYTES: number;
  readonly MCP_INVOKE_PAYLOAD_MAX_BYTES: number;
  clarifyNodeExecCwdSpawnError(error: NodeJS.ErrnoException, cwd: string | undefined): string;
  runCommand(
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutMs: number | undefined,
  ): Promise<RunResult>;
};

function getTestApi(): NodeHostInvokeTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.nodeHostInvokeTestApi")
  ] as NodeHostInvokeTestApi;
}

export const testing: NodeHostInvokeTestApi = {
  get MCP_TEXT_CONTENT_MAX_BYTES() {
    return getTestApi().MCP_TEXT_CONTENT_MAX_BYTES;
  },
  get MCP_INVOKE_PAYLOAD_MAX_BYTES() {
    return getTestApi().MCP_INVOKE_PAYLOAD_MAX_BYTES;
  },
  clarifyNodeExecCwdSpawnError(error, cwd) {
    return getTestApi().clarifyNodeExecCwdSpawnError(error, cwd);
  },
  runCommand(argv, cwd, env, timeoutMs) {
    return getTestApi().runCommand(argv, cwd, env, timeoutMs);
  },
};
