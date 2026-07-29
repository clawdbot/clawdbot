// PTY adapter wraps pseudo-terminal processes for the process supervisor.
import type { IDisposable } from "@lydell/node-pty";
import { signalProcessTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import {
  readPtyTerminalName,
  resolvePtyTerminalName,
  setPtyTerminalName,
} from "../../pty-terminal-name.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;

type PtyAdapter = SpawnProcessAdapter;

export async function createPtyAdapter(params: {
  shell: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
}): Promise<PtyAdapter> {
  const { spawn } = await import("@lydell/node-pty");
  const baseEnv = params.env ? toStringEnv(params.env) : undefined;
  const preparedSpawn = prepareOomScoreAdjustedSpawn(params.shell, params.args, { env: baseEnv });
  const terminalName = resolvePtyTerminalName(
    params.name ??
      readPtyTerminalName(preparedSpawn.env, process.platform) ??
      readPtyTerminalName(process.env, process.platform),
  );
  const spawnEnv = preparedSpawn.env
    ? toStringEnv(preparedSpawn.env)
    : process.platform === "win32"
      ? toStringEnv(process.env)
      : undefined;
  // Unix node-pty rewrites child TERM from name; Windows forwards env unchanged.
  if (spawnEnv) {
    setPtyTerminalName({ env: spawnEnv, name: terminalName, platform: process.platform });
  }
  const pty = spawn(preparedSpawn.command, preparedSpawn.args, {
    cwd: params.cwd,
    env: spawnEnv,
    name: terminalName,
    cols: params.cols ?? 120,
    rows: params.rows ?? 30,
  });

  let dataListener: IDisposable | null = null;
  let exitListener: IDisposable | null = null;
  let waitResult: { code: number | null; signal: NodeJS.Signals | number | null } | null = null;
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | number | null }) => void)
    | null = null;
  let waitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | number | null }> | null =
    null;
  let forceKillWaitFallbackTimer: NodeJS.Timeout | null = null;
  let stdinDestroyed = false;
  let stdinEnded = false;

  const clearForceKillWaitFallback = () => {
    if (!forceKillWaitFallbackTimer) {
      return;
    }
    clearTimeout(forceKillWaitFallbackTimer);
    forceKillWaitFallbackTimer = null;
  };

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | number | null }) => {
    if (waitResult) {
      return;
    }
    clearForceKillWaitFallback();
    stdinDestroyed = true;
    stdinEnded = true;
    waitResult = value;
    if (resolveWait) {
      const resolve = resolveWait;
      resolveWait = null;
      resolve(value);
    }
  };

  const scheduleForceKillWaitFallback = (signal: NodeJS.Signals) => {
    clearForceKillWaitFallback();
    // Some PTY hosts fail to emit onExit after kill; use a delayed fallback
    // so callers can still unblock without marking termination immediately.
    forceKillWaitFallbackTimer = setTimeout(() => {
      settleWait({ code: null, signal });
    }, FORCE_KILL_WAIT_FALLBACK_MS);
    forceKillWaitFallbackTimer.unref();
  };

  exitListener = pty.onExit((event) => {
    const signal = event.signal && event.signal !== 0 ? event.signal : null;
    settleWait({ code: event.exitCode ?? null, signal });
  });

  const stdin: ManagedRunStdin = {
    get destroyed() {
      return stdinDestroyed;
    },
    get writable() {
      return !stdinDestroyed && !stdinEnded;
    },
    get writableEnded() {
      return stdinEnded;
    },
    get writableFinished() {
      return stdinEnded;
    },
    write: (data, cb) => {
      try {
        pty.write(data);
        cb?.(null);
      } catch (err) {
        cb?.(err as Error);
      }
    },
    end: () => {
      try {
        stdinEnded = true;
        const eof = process.platform === "win32" ? "\x1a" : "\x04";
        pty.write(eof);
      } catch {
        // ignore EOF errors
      }
    },
    destroy: () => {
      stdinDestroyed = true;
      stdinEnded = true;
    },
  };

  const onStdout = (listener: (chunk: string) => void) => {
    dataListener = pty.onData((chunk) => {
      listener(chunk);
    });
  };

  const onStderr = (_listener: (chunk: string) => void) => {
    // PTY gives a unified output stream.
  };

  const wait = async () => {
    if (waitResult) {
      return waitResult;
    }
    if (!waitPromise) {
      waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | number | null }>(
        (resolve) => {
          resolveWait = resolve;
          if (waitResult) {
            const settled = waitResult;
            resolveWait = null;
            resolve(settled);
          }
        },
      );
    }
    return waitPromise;
  };

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    try {
      if (
        (signal === "SIGKILL" || signal === "SIGTERM") &&
        typeof pty.pid === "number" &&
        pty.pid > 0
      ) {
        signalProcessTree(pty.pid, signal, { detached: true });
      } else if (process.platform === "win32") {
        pty.kill();
      } else {
        pty.kill(signal);
      }
    } catch {
      // ignore kill errors
    }

    if (signal === "SIGKILL") {
      scheduleForceKillWaitFallback(signal);
    }
  };

  const dispose = () => {
    stdinDestroyed = true;
    stdinEnded = true;
    try {
      dataListener?.dispose();
    } catch {
      // ignore disposal errors
    }
    try {
      exitListener?.dispose();
    } catch {
      // ignore disposal errors
    }
    clearForceKillWaitFallback();
    dataListener = null;
    exitListener = null;
    settleWait({ code: null, signal: null });
  };

  return {
    pid: pty.pid || undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
