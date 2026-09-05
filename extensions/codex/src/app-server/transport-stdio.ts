/**
 * Creates and configures stdio-backed Codex app-server transports, including
 * Windows spawn normalization and environment filtering.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config.js";
import { normalizeCodexAppServerArgs } from "./launch-args.js";
import { prepareCodexAppServerProcessRegistration } from "./transport-process-registration.js";
import { resolveProtectedCodexSpawnCommand } from "./transport-protected-launch.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-spawn-env.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

export { resolveCodexAppServerSpawnEnv } from "./transport-spawn-env.js";

const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";

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

/** Resolves the concrete command/argv/shell settings used to spawn Codex app-server. */
function resolveCodexAppServerSpawnInvocation(
  options: CodexAppServerStartOptions,
  runtime: CodexAppServerSpawnRuntime = DEFAULT_SPAWN_RUNTIME,
): {
  command: string;
  args: string[];
  entrypointPaths: string[];
  shell?: boolean;
  windowsHide?: boolean;
} {
  if (options.commandSource === "managed") {
    throw new Error("Managed Codex app-server start options must be resolved before spawn.");
  }
  const program = resolveWindowsSpawnProgram({
    command: options.command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const args = normalizeCodexAppServerArgs(options.args);
  const resolved = materializeWindowsSpawnProgram(program, args);
  return {
    command: resolved.command,
    args: resolved.argv,
    entrypointPaths: program.leadingArgv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

/** Keeps QA-owned app-server processes inside the gateway process-group cleanup boundary. */
function resolveCodexAppServerDetachedMode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && !env[QA_PARENT_PID_ENV]?.trim();
}

/** Spawns the Codex app-server process and returns the shared transport interface. */
export async function createStdioTransport(
  options: CodexAppServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): Promise<ChildProcessWithoutNullStreams> {
  const env = resolveCodexAppServerSpawnEnv(options, baseEnv);
  const invocation = resolveCodexAppServerSpawnInvocation(options, {
    platform: process.platform,
    env,
    execPath: process.execPath,
  });
  const register = await prepareCodexAppServerProcessRegistration();
  const command = options.protectedLaunchRoots
    ? await resolveProtectedCodexSpawnCommand(
        options,
        env,
        invocation.command,
        invocation.entrypointPaths,
      )
    : invocation.command;
  assertCurrent?.();
  const child = spawn(command, invocation.args, {
    // Preserve the shipped Supervisor endpoint contract: relative commands and
    // config discovery may depend on the endpoint's process working directory.
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env,
    detached: resolveCodexAppServerDetachedMode(env),
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
  try {
    // Attach lifecycle observers before inspection can yield to an early exit.
    onSpawn?.(child);
    await register(child);
    assertCurrent?.();
    return child;
  } catch (error) {
    await closeCodexAppServerTransportAndWait(child, { drainStdio: true });
    assertCurrent?.();
    throw error;
  }
}
