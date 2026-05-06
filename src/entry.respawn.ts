import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveNodeStartupTlsEnvironment } from "./bootstrap/node-startup-env.js";
import {
  shouldSkipRespawnForArgv,
  shouldSkipStartupEnvironmentRespawnForArgv,
} from "./cli/respawn-policy.js";
import { isTruthyEnvValue } from "./infra/env.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

export const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
export const OPENCLAW_NODE_OPTIONS_READY = "OPENCLAW_NODE_OPTIONS_READY";
export const OPENCLAW_NODE_EXTRA_CA_CERTS_READY = "OPENCLAW_NODE_EXTRA_CA_CERTS_READY";
const CLI_RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
const CLI_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;

type CliRespawnPlan = {
  command: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
};

type CliRespawnRuntime = {
  spawn: typeof spawn;
  attachChildProcessBridge: typeof attachChildProcessBridge;
  exit: (code?: number) => never;
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

  if (
    shouldSkipStartupEnvironmentRespawnForArgv(argv) ||
    isTruthyEnvValue(env.OPENCLAW_NO_RESPAWN)
  ) {
    return null;
  }

  if (platform === "win32") {
    return null;
  }

  const childEnv: NodeJS.ProcessEnv = { ...env };
  const childExecArgv = [...execArgv];
  let needsRespawn = false;

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
  const child = runtime.spawn(plan.command, plan.argv, {
    stdio: "inherit",
    env: plan.env,
  });
  let signalExitTimer: NodeJS.Timeout | undefined;
  let signalForceKillTimer: NodeJS.Timeout | undefined;
  const clearSignalTimers = (): void => {
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = undefined;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = undefined;
    }
  };
  const forceKillChild = (): void => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      forceKillChild();
      runtime.exit(1);
    }, CLI_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (): void => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, CLI_RESPAWN_SIGNAL_EXIT_GRACE_MS);
    signalExitTimer.unref?.();
  };

  runtime.attachChildProcessBridge(child, {
    onSignal: scheduleParentExit,
  });

  child.once("exit", (code, signal) => {
    clearSignalTimers();
    if (signal) {
      runtime.exit(1);
      return;
    }
    runtime.exit(code ?? 1);
  });

  child.once("error", (error) => {
    clearSignalTimers();
    runtime.writeError(
      "[openclaw] Failed to respawn CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    runtime.exit(1);
  });

  return child;
}
