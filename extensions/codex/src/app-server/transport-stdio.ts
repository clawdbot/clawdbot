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

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RUNTIME_INJECTION_ENVIRONMENT_KEYS = new Set([
  "NODE_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
]);
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
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
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
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

/** Merges app-server environment overrides while honoring clearEnv and unsafe key filtering. */
export function resolveCodexAppServerSpawnEnv(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  copySafeEnvironmentEntries(env, baseEnv);
  copySafeEnvironmentEntries(env, options.env ?? {});
  const keysToClear = normalizedEnvironmentKeys(options.clearEnv ?? []);
  if (platform === "win32") {
    const lowerCaseKeysToClear = new Set(keysToClear.map((key) => key.toLowerCase()));
    for (const candidate of Object.keys(env)) {
      if (lowerCaseKeysToClear.has(candidate.toLowerCase())) {
        delete env[candidate];
      }
    }
  } else {
    for (const key of keysToClear) {
      delete env[key];
    }
  }
  for (const key of Object.keys(env)) {
    if (isCodexRuntimeInjectionEnvironmentKey(key)) {
      // Package managers and agent hosts may inject loader paths into their children. Codex does
      // not need them, so strip them before attestation and spawn instead of self-failing setup.
      delete env[key];
    }
  }
  return env;
}

function isCodexRuntimeInjectionEnvironmentKey(rawKey: string): boolean {
  const key = rawKey.toUpperCase();
  return RUNTIME_INJECTION_ENVIRONMENT_KEYS.has(key) || key.startsWith("DYLD_");
}

/** Keeps QA-owned app-server processes inside the gateway process-group cleanup boundary. */
function resolveCodexAppServerDetachedMode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && !env[QA_PARENT_PID_ENV]?.trim();
}

function normalizedEnvironmentKeys(rawKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const rawKey of rawKeys) {
    const key = rawKey.trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

function copySafeEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_ENVIRONMENT_KEYS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}

/** Spawns the Codex app-server process and returns the shared transport interface. */
export async function createStdioTransport(
  options: CodexAppServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
): Promise<ChildProcessWithoutNullStreams> {
  const env = resolveCodexAppServerSpawnEnv(options, baseEnv);
  const invocation = resolveCodexAppServerSpawnInvocation(options, {
    platform: process.platform,
    env,
    execPath: process.execPath,
  });
  const register = await prepareCodexAppServerProcessRegistration();
  assertCurrent?.();
  const child = spawn(invocation.command, invocation.args, {
    // Preserve the shipped Supervisor endpoint contract: relative commands and
    // config discovery may depend on the endpoint's process working directory.
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env,
    detached: resolveCodexAppServerDetachedMode(env),
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
  await register(child);
  try {
    assertCurrent?.();
    return child;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}
