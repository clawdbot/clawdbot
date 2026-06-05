// Respawn child runner restarts child processes after configured exits.
import type { ChildProcess, spawn } from "node:child_process";
import type { attachChildProcessBridge } from "./child-process-bridge.js";

const RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
const RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;
const RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS = 1_000;

export type RespawnChildRuntime = {
  spawn: typeof spawn;
  attachChildProcessBridge: typeof attachChildProcessBridge;
  exit: (code?: number) => never;
};

export function runRespawnChildWithSignalBridge(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runtime: RespawnChildRuntime;
  onError: (error: unknown) => void;
}): ChildProcess {
  const { command, args, env, runtime, onError } = params;
  const child = runtime.spawn(command, args, {
    stdio: "inherit",
    env,
  });

  // Let the child honor forwarded signals first; then terminate it so the
  // wrapper process cannot stay alive indefinitely after the parent is signaled.
  let signalExitTimer: NodeJS.Timeout | undefined;
  let signalForceKillTimer: NodeJS.Timeout | undefined;
  let signalHardExitTimer: NodeJS.Timeout | undefined;
  const clearSignalTimers = (): void => {
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = undefined;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = undefined;
    }
    if (signalHardExitTimer) {
      clearTimeout(signalHardExitTimer);
      signalHardExitTimer = undefined;
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
      signalHardExitTimer = setTimeout(() => {
        runtime.exit(1);
      }, RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS);
      signalHardExitTimer.unref?.();
    }, RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (): void => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, RESPAWN_SIGNAL_EXIT_GRACE_MS);
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
    onError(error);
    runtime.exit(1);
  });

  return child;
}
