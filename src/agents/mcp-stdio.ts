/**
 * Stdio MCP launch config normalization.
 * Accepts OpenClaw and upstream MCP config field names, keeping only
 * command/args/env/cwd needed to spawn a stdio server.
 */
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { isMcpConfigRecord, toMcpEnvRecord, toMcpStringArray } from "./mcp-config-shared.js";

/** Normalized stdio MCP server launch config. */
export type StdioMcpServerLaunchConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type StdioMcpServerLaunchResult =
  | { ok: true; config: StdioMcpServerLaunchConfig }
  | { ok: false; reason: string };

/** Resolve raw MCP server config into a stdio launch config. */
export function resolveStdioMcpServerLaunchConfig(
  raw: unknown,
  options?: { onDroppedEnv?: (key: string, value: unknown) => void },
): StdioMcpServerLaunchResult {
  if (!isMcpConfigRecord(raw)) {
    return { ok: false, reason: "server config must be an object" };
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    if (typeof raw.url === "string" && raw.url.trim().length > 0) {
      return {
        ok: false,
        reason: "not a stdio server (has url)",
      };
    }
    return { ok: false, reason: "its command is missing" };
  }
  const cwd =
    typeof raw.cwd === "string" && raw.cwd.trim().length > 0
      ? raw.cwd
      : typeof raw.workingDirectory === "string" && raw.workingDirectory.trim().length > 0
        ? raw.workingDirectory
        : undefined;
  return {
    ok: true,
    config: {
      command: raw.command,
      args: toMcpStringArray(raw.args),
      env: toMcpEnvRecord(raw.env, { onDroppedEntry: options?.onDroppedEnv }),
      cwd,
    },
  };
}

/** Describe a stdio MCP launch config for diagnostics. */
export function describeStdioMcpServerLaunchConfig(config: StdioMcpServerLaunchConfig): string {
  const redactedArgs = Array.isArray(config.args) ? redactSensitiveArgv(config.args) : [];
  const args = redactedArgs.length > 0 ? ` ${redactedArgs.join(" ")}` : "";
  const cwd = config.cwd ? ` (cwd=${config.cwd})` : "";
  return `${config.command}${args}${cwd}`;
}
