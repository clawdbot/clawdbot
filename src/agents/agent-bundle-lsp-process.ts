/** Spawns bundled LSP server processes with sanitized environment and platform handling. */
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { createOwnedStdioProcess, type OwnedStdioProcess } from "../process/owned-stdio.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

type LspSpawnDependencies = {
  spawn: typeof createOwnedStdioProcess;
  sanitizeHostExecEnv: typeof sanitizeHostExecEnv;
  resolveWindowsSpawnProgram: typeof resolveWindowsSpawnProgram;
  materializeWindowsSpawnProgram: typeof materializeWindowsSpawnProgram;
};

const defaultLspSpawnDependencies: LspSpawnDependencies = {
  spawn: createOwnedStdioProcess,
  sanitizeHostExecEnv,
  resolveWindowsSpawnProgram,
  materializeWindowsSpawnProgram,
};

export async function spawnLspServerProcess(
  config: StdioMcpServerLaunchConfig,
  dependencies: LspSpawnDependencies = defaultLspSpawnDependencies,
): Promise<OwnedStdioProcess> {
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
  return await dependencies.spawn({
    argv: [invocation.command, ...invocation.argv],
    env: mergedEnv,
    exactEnv: true,
    cwd: config.cwd,
    // Stable LSP config permits unresolved Windows wrappers to use Node's shell parsing.
    ...(invocation.shell === true ? { windowsShell: true } : {}),
  });
}
