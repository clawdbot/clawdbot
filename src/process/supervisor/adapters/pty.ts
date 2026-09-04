// PTY adapter wraps pseudo-terminal processes for the process supervisor.
import type { IDisposable } from "@lydell/node-pty";
import { createDeferredCore } from "../../../shared/deferred.js";
import { signalPtySessionTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import {
  readPtyTerminalName,
  resolvePtyTerminalName,
  setPtyTerminalName,
} from "../../pty-terminal-name.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
declare const WORKER_DEPLOY_BUILD: boolean;

type PtyAdapter = SpawnProcessAdapter;

export async function createPtyAdapter(params: {
  assertCurrent?: () => void;
  shell: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
  abortSignal?: AbortSignal;
}): Promise<PtyAdapter> {
  // Worker deploys are portable JavaScript artifacts; exec falls back to the child adapter
  // instead of binding the Gateway host's native PTY binary into the bundle.
  if (typeof WORKER_DEPLOY_BUILD === "boolean" && WORKER_DEPLOY_BUILD) {
    throw new Error("PTY is unavailable in the portable worker runtime");
  }
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
  params.assertCurrent?.();
  // Construction can be cancelled while the native module loads.
  if (params.abortSignal?.aborted) {
    throw new Error("PTY construction aborted");
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
  const completion = createDeferredCore<{
    code: number | null;
    signal: NodeJS.Signals | number | null;
  }>();
  let waitSettled = false;
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
    if (waitSettled) {
      return;
    }
    waitSettled = true;
    clearForceKillWaitFallback();
    stdinDestroyed = true;
    stdinEnded = true;
    completion.resolve(value);
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

  const wait = async () => await completion.promise;

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    try {
      if (
        (signal === "SIGKILL" || signal === "SIGTERM") &&
        typeof pty.pid === "number" &&
        pty.pid > 0
      ) {
        signalPtySessionTree(pty.pid, signal);
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
    oomScoreWrapperSelected: preparedSpawn.wrapped,
    supportsRawOutput: false,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
