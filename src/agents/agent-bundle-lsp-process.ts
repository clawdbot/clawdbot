/** Spawns bundled LSP server processes with sanitized environment and platform handling. */
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

type LspSpawnDependencies = {
  spawn: typeof spawn;
  sanitizeHostExecEnv: typeof sanitizeHostExecEnv;
  resolveWindowsSpawnProgram: typeof resolveWindowsSpawnProgram;
  materializeWindowsSpawnProgram: typeof materializeWindowsSpawnProgram;
};

const defaultLspSpawnDependencies: LspSpawnDependencies = {
  spawn,
  sanitizeHostExecEnv,
  resolveWindowsSpawnProgram,
  materializeWindowsSpawnProgram,
};

export function spawnLspServerProcess(
  config: StdioMcpServerLaunchConfig,
  dependencies: LspSpawnDependencies = defaultLspSpawnDependencies,
): ChildProcess {
  const mergedEnv = dependencies.sanitizeHostExecEnv({
    baseEnv: process.env,
    overrides: config.env ?? null,
  });
  const program = dependencies.resolveWindowsSpawnProgram({
    command: config.command,
    env: mergedEnv,
    allowShellFallback: true,
  });
  const invocation = dependencies.materializeWindowsSpawnProgram(program, config.args ?? []);
  return dependencies.spawn(invocation.command, invocation.argv, {
    stdio: ["pipe", "pipe", "pipe"],
    env: mergedEnv,
    cwd: config.cwd,
    detached: process.platform !== "win32",
    windowsHide: invocation.windowsHide ?? process.platform === "win32",
    shell: invocation.shell,
  });
}
