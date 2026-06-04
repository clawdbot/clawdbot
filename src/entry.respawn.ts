// Respawns the CLI with adjusted process flags when startup requires it.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveNodeStartupTlsEnvironment } from "./bootstrap/node-startup-env.js";
import {
  shouldSkipRespawnForArgv,
  shouldSkipStartupEnvironmentRespawnForArgv,
} from "./cli/respawn-policy.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { isTruthyEnvValue } from "./infra/env.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";
import {
  runRespawnChildWithSignalBridge,
  type RespawnChildRuntime,
} from "./process/respawn-child-runner.js";

export const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
export const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";
export const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";
const WINDOWS_STACK_SIZE_FLAG = "--stack-size=8192";

type CliRespawnPlan = {
  command: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
};

type CliRespawnRuntime = RespawnChildRuntime & {
  writeError: (message: string, error?: unknown) => void;
};

function pathModuleForPlatform(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveCliRespawnCommand(params: {
  execPath: string;
  platform?: NodeJS.Platform;
}): string {
  const platform = params.platform ?? process.platform;
  const basename = pathModuleForPlatform(platform).basename(params.execPath).toLowerCase();
  if (basename === "volta-shim" || basename === "volta-shim.exe") {
    return "node";
  }
  return params.execPath;
}

function hasExperimentalWarningSuppressed(
  params: {
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
  } = {},
): boolean {
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings")) {
    return true;
  }
  return execArgv.some((arg) => arg === EXPERIMENTAL_WARNING_FLAG || arg === "--no-warnings");
}

function hasStackSizeConfigured(execArgv: string[]): boolean {
  return execArgv.some(
    (arg) =>
      arg === "--stack-size" ||
      arg.startsWith("--stack-size=") ||
      arg === "--stack_size" ||
      arg.startsWith("--stack_size="),
  );
}

export function buildCliRespawnPlan(
  params: {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    execPath?: string;
    autoNodeExtraCaCerts?: string | undefined;
    platform?: NodeJS.Platform;
  } = {},
): CliRespawnPlan | null {
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const execPath = params.execPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const normalizedArgv =
    platform === "win32" ? normalizeWindowsArgv(argv, { platform, execPath }) : argv;

  if (
    shouldSkipStartupEnvironmentRespawnForArgv(normalizedArgv) ||
    isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)
  ) {
    return null;
  }

  const childEnv: NodeJS.ProcessEnv = { ...env };
  const childExecArgv = [...execArgv];
  let needsRespawn = false;

  if (platform === "win32") {
    if (!hasStackSizeConfigured(childExecArgv)) {
      childExecArgv.unshift(WINDOWS_STACK_SIZE_FLAG);
      needsRespawn = true;
    }

    if (!needsRespawn) {
      return null;
    }

    return {
      command: resolveCliRespawnCommand({ execPath, platform }),
      argv: [...childExecArgv, ...normalizedArgv.slice(1)],
      env: childEnv,
    };
  }

  const autoNodeExtraCaCerts =
    params.autoNodeExtraCaCerts ??
    resolveNodeStartupTlsEnvironment({
      env,
      execPath,
      includeDarwinDefaults: false,
    }).NODE_EXTRA_CA_CERTS;
  if (
    autoNodeExtraCaCerts &&
    !isTruthyEnvValue(env[OPENCLAW_NODE_EXTRA_CA_CERTS_READY]) &&
    !env.NODE_EXTRA_CA_CERTS
  ) {
    childEnv.NODE_EXTRA_CA_CERTS = autoNodeExtraCaCerts;
    childEnv[OPENCLAW_NODE_EXTRA_CA_CERTS_READY] = "1";
    needsRespawn = true;
  }

  if (
    !shouldSkipRespawnForArgv(argv) &&
    !isTruthyEnvValue(env[OPENCLAW_NODE_OPTIONS_READY]) &&
    !hasExperimentalWarningSuppressed({ env, execArgv })
  ) {
    childEnv[OPENCLAW_NODE_OPTIONS_READY] = "1";
    childExecArgv.unshift(EXPERIMENTAL_WARNING_FLAG);
    needsRespawn = true;
  }

  if (!needsRespawn) {
    return null;
  }

  return {
    command: resolveCliRespawnCommand({ execPath, platform }),
    argv: [...childExecArgv, ...argv.slice(1)],
    env: childEnv,
  };
}

export function runCliRespawnPlan(
  plan: CliRespawnPlan,
  runtime: CliRespawnRuntime = {
    spawn,
    attachChildProcessBridge,
    exit: process.exit.bind(process) as (code?: number) => never,
    writeError: (message, error) => console.error(message, error),
  },
): ChildProcess {
  return runRespawnChildWithSignalBridge({
    command: plan.command,
    args: plan.argv,
    env: plan.env,
    runtime,
    onError: (error) => {
      runtime.writeError(
        "[openclaw] Failed to respawn CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
    },
  });
}
