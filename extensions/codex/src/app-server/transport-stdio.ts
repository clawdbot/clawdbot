import { spawn } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

type CodexAppServerSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_SPAWN_RUNTIME: CodexAppServerSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function resolveCodexAppServerSpawnInvocation(
  options: CodexAppServerStartOptions,
  runtime: CodexAppServerSpawnRuntime = DEFAULT_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  const program = resolveWindowsSpawnProgram({
    command: options.command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const resolved = materializeWindowsSpawnProgram(program, options.args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  const env = {
    ...process.env,
    ...options.env,
  };
  for (const key of options.clearEnv ?? []) {
    delete env[key];
  }
  const invocation = resolveCodexAppServerSpawnInvocation(options, {
    platform: process.platform,
    env,
    execPath: process.execPath,
  });
  return spawn(invocation.command, invocation.args, {
    env,
    detached: process.platform !== "win32",
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
}
