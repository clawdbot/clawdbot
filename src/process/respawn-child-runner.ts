// Respawn child runner restarts child processes after configured exits.
import type { ChildProcess, spawn } from "node:child_process";
import type { attachChildProcessBridge } from "./child-process-bridge.js";
import { signalProcessTree } from "./kill-tree.js";

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
  detachForProcessTree?: boolean;
  stdioIsTerminal?: boolean;
  runtime: RespawnChildRuntime;
  onError: (error: unknown) => void;
}): ChildProcess {
  const { command, args, env, runtime, onError } = params;
  const stdioIsTerminal = params.stdioIsTerminal ?? (process.stdin.isTTY || process.stdout.isTTY);
  const detachForProcessTree =
    params.detachForProcessTree === true && process.platform !== "win32" && !stdioIsTerminal;
  const child = runtime.spawn(command, args, {
    stdio: "inherit",
    env,
    detached: detachForProcessTree,
  });

  // Let the child honor forwarded signals first; then terminate it so the
  // wrapper process cannot stay alive indefinitely after the parent is signaled.
  let signalExitTimer: NodeJS.Timeout | undefined;
  let signalForceKillTimer: NodeJS.Timeout | undefined;
  let signalHardExitTimer: NodeJS.Timeout | undefined;
  let parentSignalReceived = false;
  let firstForwardedSignal: NodeJS.Signals | undefined;
  let hardKillBackstopStarted = false;
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
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (detachForProcessTree && typeof child.pid === "number" && child.pid > 0) {
      signalProcessTree(child.pid, signal, { detached: true });
      return;
    }
    child.kill(signal === "SIGKILL" && process.platform === "win32" ? "SIGTERM" : signal);
  };
  const forceKillChild = (): void => {
    try {
      signalChild("SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = (): void => {
    try {
      signalChild("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      hardKillBackstopStarted = true;
      forceKillChild();
      signalHardExitTimer = setTimeout(() => {
        runtime.exit(1);
      }, RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS);
      signalHardExitTimer.unref?.();
    }, RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (signal: NodeJS.Signals): void => {
    parentSignalReceived = true;
    firstForwardedSignal ??= signal;
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
    if (parentSignalReceived && detachForProcessTree) {
      forceKillChild();
    }
    clearSignalTimers();
    if (signal) {
      const forwardedSignalExitCode =
        !hardKillBackstopStarted && signal === firstForwardedSignal
          ? signal === "SIGINT"
            ? 130
            : signal === "SIGTERM"
              ? 143
              : undefined
          : undefined;
      runtime.exit(forwardedSignalExitCode ?? 1);
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
