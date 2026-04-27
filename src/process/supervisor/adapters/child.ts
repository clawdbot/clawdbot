import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { createWindowsOutputDecoder } from "../../../infra/windows-encoding.js";
import { killProcessTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import { resolveWindowsCommandShim } from "../../windows-command.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;

function resolveCommand(command: string): string {
  return resolveWindowsCommandShim({
    command,
    cmdCommands: ["npm", "pnpm", "yarn", "npx"],
  });
}

export type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;

function isServiceManagedRuntime(): boolean {
  return Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
}

export async function createChildAdapter(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
}): Promise<ChildAdapter> {
  const resolvedArgv = [...params.argv];
  resolvedArgv[0] = resolveCommand(resolvedArgv[0] ?? "");
  const baseEnv = params.env ? toStringEnv(params.env) : undefined;
  const preparedSpawn = prepareOomScoreAdjustedSpawn(resolvedArgv[0] ?? "", resolvedArgv.slice(1), {
    env: baseEnv,
  });

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // In service-managed mode keep children attached so systemd/launchd can
  // stop the full process tree reliably. Outside service mode preserve the
  // existing POSIX detached behavior.
  const useDetached = process.platform !== "win32" && !isServiceManagedRuntime();

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: preparedSpawn.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  };
  if (stdinMode === "inherit") {
    options.stdio = ["inherit", "pipe", "pipe"];
  } else {
    options.stdio = ["pipe", "pipe", "pipe"];
  }

  const spawned = await spawnWithFallback({
    argv: [preparedSpawn.command, ...preparedSpawn.args],
    options,
    fallbacks: useDetached
      ? [
          {
            label: "no-detach",
            options: { detached: false },
          },
        ]
      : [],
  });

  const child = spawned.child as ChildProcessWithoutNullStreams;
  if (child.stdin) {
    if (params.input !== undefined) {
      child.stdin.write(params.input);
      child.stdin.end();
    } else if (stdinMode === "pipe-closed") {
      child.stdin.end();
    }
  }

  const stdin: ManagedRunStdin | undefined = child.stdin
    ? {
        destroyed: false,
        write: (data: string, cb?: (err?: Error | null) => void) => {
          try {
            child.stdin.write(data, cb);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try {
            child.stdin.end();
          } catch {
            // ignore close errors
          }
        },
        destroy: () => {
          try {
            child.stdin.destroy();
          } catch {
            // ignore destroy errors
          }
        },
      }
    : undefined;

  const onStdout = (listener: (chunk: string) => void) => {
    const stdoutDecoder = createWindowsOutputDecoder();
    let flushed = false;
    const flush = () => {
      if (flushed) {
        return;
      }
      flushed = true;
      const tail = stdoutDecoder.flush();
      if (tail) {
        listener(tail);
      }
    };
    child.stdout.on("data", (chunk) => {
      const text = stdoutDecoder.decode(chunk);
      if (text) {
        listener(text);
      }
    });
    child.stdout.once("end", flush);
    child.stdout.once("close", flush);
  };

  const onStderr = (listener: (chunk: string) => void) => {
    const stderrDecoder = createWindowsOutputDecoder();
    let flushed = false;
    const flush = () => {
      if (flushed) {
        return;
      }
      flushed = true;
      const tail = stderrDecoder.flush();
      if (tail) {
        listener(tail);
      }
    };
    child.stderr.on("data", (chunk) => {
      const text = stderrDecoder.decode(chunk);
      if (text) {
        listener(text);
      }
    });
    child.stderr.once("end", flush);
    child.stderr.once("close", flush);
  };

  let waitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let waitError: unknown;
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  let rejectWait: ((reason?: unknown) => void) | null = null;
  let waitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let forceKillWaitFallbackTimer: NodeJS.Timeout | null = null;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let windowsCloseFallbackTimer: NodeJS.Timeout | null = null;
  let stdoutDrained = child.stdout == null;
  let stderrDrained = child.stderr == null;

  const clearForceKillWaitFallback = () => {
    if (!forceKillWaitFallbackTimer) {
      return;
    }
    clearTimeout(forceKillWaitFallbackTimer);
    forceKillWaitFallbackTimer = null;
  };

  const clearWindowsCloseFallbackTimer = () => {
    if (!windowsCloseFallbackTimer) {
      return;
    }
    clearTimeout(windowsCloseFallbackTimer);
    windowsCloseFallbackTimer = null;
  };

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (waitResult || waitError !== undefined) {
      return;
    }
    clearForceKillWaitFallback();
    clearWindowsCloseFallbackTimer();
    waitResult = value;
    if (resolveWait) {
      const resolve = resolveWait;
      resolveWait = null;
      rejectWait = null;
      resolve(value);
    }
  };

  const rejectPendingWait = (error: unknown) => {
    if (waitResult || waitError !== undefined) {
      return;
    }
    clearForceKillWaitFallback();
    clearWindowsCloseFallbackTimer();
    waitError = error;
    if (rejectWait) {
      const reject = rejectWait;
      resolveWait = null;
      rejectWait = null;
      reject(error);
    }
  };

  const scheduleForceKillWaitFallback = (signal: NodeJS.Signals) => {
    clearForceKillWaitFallback();
    // Some Windows child processes never emit `close` after a hard kill.
    forceKillWaitFallbackTimer = setTimeout(() => {
      settleWait({ code: null, signal });
    }, FORCE_KILL_WAIT_FALLBACK_MS);
    forceKillWaitFallbackTimer.unref?.();
  };

  const resolveObservedExitState = (fallback: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => {
    if (childExitState != null) {
      return childExitState;
    }
    return {
      code: child.exitCode ?? fallback.code,
      signal: child.signalCode ?? fallback.signal,
    };
  };

  const maybeSettleAfterWindowsExit = () => {
    if (
      process.platform !== "win32" ||
      childExitState == null ||
      !stdoutDrained ||
      !stderrDrained
    ) {
      return;
    }
    settleWait(resolveObservedExitState(childExitState));
  };

  const scheduleWindowsCloseFallback = () => {
    if (process.platform !== "win32") {
      return;
    }
    clearWindowsCloseFallbackTimer();
    windowsCloseFallbackTimer = setTimeout(() => {
      maybeSettleAfterWindowsExit();
    }, WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS);
    windowsCloseFallbackTimer.unref?.();
  };

  child.stdout?.once("end", () => {
    stdoutDrained = true;
    maybeSettleAfterWindowsExit();
  });
  child.stdout?.once("close", () => {
    stdoutDrained = true;
    maybeSettleAfterWindowsExit();
  });
  child.stderr?.once("end", () => {
    stderrDrained = true;
    maybeSettleAfterWindowsExit();
  });
  child.stderr?.once("close", () => {
    stderrDrained = true;
    maybeSettleAfterWindowsExit();
  });

  child.once("error", (error) => {
    rejectPendingWait(error);
  });
  child.once("exit", (code, signal) => {
    childExitState = { code, signal };
    scheduleWindowsCloseFallback();
  });
  child.once("close", (code, signal) => {
    settleWait(resolveObservedExitState({ code, signal }));
  });

  const wait = async () => {
    if (waitResult) {
      return waitResult;
    }
    if (waitError !== undefined) {
      throw waitError;
    }
    if (!waitPromise) {
      waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
          if (waitResult) {
            const settled = waitResult;
            resolveWait = null;
            rejectWait = null;
            resolve(settled);
            return;
          }
          if (waitError !== undefined) {
            const error = waitError;
            resolveWait = null;
            rejectWait = null;
            reject(error);
          }
        },
      );
    }
    return waitPromise;
  };

  // The actual detachment of the spawned child can differ from `useDetached`:
  // when the detached spawn fails, `spawnWithFallback` retries with the
  // `no-detach` fallback (detached:false). In that case the child shares the
  // gateway's process group regardless of intent, so the kill must avoid
  // group-kill. (#71662 follow-up — caught by Greptile review)
  const childIsDetached = useDetached && !spawned.usedFallback;
  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      if (pid) {
        // Pass through whether the child is actually detached. Without this,
        // `killProcessTree` group-kills via `-pid` and takes out the gateway's
        // own process group along with the child. (#71662)
        killProcessTree(pid, { detached: childIsDetached });
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill errors
      }
      scheduleForceKillWaitFallback("SIGKILL");
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore kill errors for non-kill signals
    }
  };

  const dispose = () => {
    clearForceKillWaitFallback();
    clearWindowsCloseFallbackTimer();
    child.removeAllListeners();
  };

  return {
    pid: child.pid ?? undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
