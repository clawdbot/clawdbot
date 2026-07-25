// Child process adapter wraps spawned child processes for the supervisor.
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { toErrorObject } from "../../../infra/errors.js";
import { createWindowsOutputDecoder } from "../../../infra/windows-encoding.js";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../../../plugin-sdk/windows-spawn.js";
import { signalProcessTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import {
  addSecretInputStdio,
  type SpawnStdioEntry,
  writeSecretInputToChild,
} from "../../spawn-secret-input.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
  resolveWindowsCommandShim,
} from "../../windows-command.js";
import type { ManagedRunStdin, SpawnProcessAdapter, SpawnSecretInput } from "../types.js";
import { toStringEnv } from "./env.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;
const FORCED_WINDOWS_CLOSE_SETTLE_MS = 250;
const WINDOWS_PACKAGE_MANAGER_SHIMS = ["npm", "pnpm", "yarn", "npx"] as const;

function resolveChildInvocation(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}): {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
} {
  const command = params.argv[0] ?? "";
  const candidate = resolveWindowsSpawnProgramCandidate({
    command,
    env: params.env,
    // npm shims invoke `node` from PATH; process.execPath may be a packaged OpenClaw executable.
    execPath:
      process.platform === "win32"
        ? resolveWindowsExecutablePath("node", params.env ?? process.env)
        : undefined,
  });
  const args = [...candidate.leadingArgv, ...params.argv.slice(1)];
  // Keep the historical package-manager fallback when PATH probing cannot see
  // its shim; every resolved wrapper takes the direct Node/exe path above.
  const resolvedCommand =
    candidate.resolution === "direct" && candidate.command === command
      ? resolveWindowsCommandShim({
          command,
          cmdCommands: WINDOWS_PACKAGE_MANAGER_SHIMS,
        })
      : candidate.command;
  if (!isWindowsBatchCommand(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args,
      windowsVerbatimArguments: params.windowsVerbatimArguments,
    };
  }
  return {
    command: resolveTrustedWindowsCmdExe(),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(resolvedCommand, args)],
    windowsVerbatimArguments: true,
  };
}

type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;

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
  secretInput?: SpawnSecretInput;
}): Promise<ChildAdapter> {
  const baseEnv = params.env ? toStringEnv(params.env) : undefined;
  const invocation = resolveChildInvocation({
    argv: params.argv,
    env: baseEnv,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  });
  const preparedSpawn = prepareOomScoreAdjustedSpawn(invocation.command, invocation.args, {
    env: baseEnv,
  });

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // In service-managed mode keep children attached so systemd/launchd can
  // stop the full process tree reliably. Outside service mode preserve the
  // existing POSIX detached behavior.
  const useDetached = process.platform !== "win32" && !isServiceManagedRuntime();

  const stdio: SpawnStdioEntry[] = [stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  addSecretInputStdio(stdio, params.secretInput);

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: preparedSpawn.env,
    stdio,
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };

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
  // Pipe errors can arrive before output subscribers attach. Close remains
  // responsible for decoder flush and Windows drain completion.
  const ignoreOutputStreamError = () => {};
  child.stdout.on("error", ignoreOutputStreamError);
  child.stderr.on("error", ignoreOutputStreamError);
  const childStdin = spawned.child.stdin;
  let stdinDestroyed = childStdin?.destroyed ?? false;
  let stdinEnded = childStdin?.writableEnded === true || childStdin?.writableFinished === true;
  if (childStdin) {
    childStdin.once("finish", () => {
      stdinEnded = true;
    });
    childStdin.once("close", () => {
      stdinEnded = true;
      stdinDestroyed = true;
    });
    childStdin.once("error", () => {
      stdinDestroyed = true;
    });
    if (params.input !== undefined) {
      childStdin.write(params.input);
      stdinEnded = true;
      childStdin.end();
    } else if (stdinMode === "pipe-closed") {
      stdinEnded = true;
      childStdin.end();
    }
  }

  const stdin: ManagedRunStdin | undefined = childStdin
    ? {
        get destroyed() {
          return stdinDestroyed || childStdin.destroyed;
        },
        get writable() {
          return !stdinDestroyed && !stdinEnded && childStdin.writable;
        },
        get writableEnded() {
          return stdinEnded || childStdin.writableEnded;
        },
        get writableFinished() {
          return childStdin.writableFinished;
        },
        write: (data: string, cb?: (err?: Error | null) => void) => {
          if (stdinDestroyed || stdinEnded || !childStdin.writable) {
            cb?.(new Error("stdin is not writable"));
            return;
          }
          try {
            childStdin.write(data, cb);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try {
            stdinEnded = true;
            childStdin.end();
          } catch {
            // ignore close errors
          }
        },
        destroy: () => {
          try {
            stdinDestroyed = true;
            stdinEnded = true;
            childStdin.destroy();
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
  let forcedWindowsCloseTimer: NodeJS.Timeout | null = null;
  let hardKillRequested = false;
  let windowsTreeKillCompleted = false;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let childCloseState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stdoutDrained = child.stdout == null;
  let stderrDrained = child.stderr == null;

  const clearForceKillWaitFallback = () => {
    if (!forceKillWaitFallbackTimer) {
      return;
    }
    clearTimeout(forceKillWaitFallbackTimer);
    forceKillWaitFallbackTimer = null;
  };

  const clearForcedWindowsCloseTimer = () => {
    if (!forcedWindowsCloseTimer) {
      return;
    }
    clearTimeout(forcedWindowsCloseTimer);
    forcedWindowsCloseTimer = null;
  };

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (waitResult || waitError !== undefined) {
      return;
    }
    clearForceKillWaitFallback();
    clearForcedWindowsCloseTimer();
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
    clearForcedWindowsCloseTimer();
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

  const scheduleForcedWindowsCloseSettlement = () => {
    if (
      process.platform !== "win32" ||
      !hardKillRequested ||
      !windowsTreeKillCompleted ||
      childExitState == null ||
      forcedWindowsCloseTimer
    ) {
      return;
    }
    const exitState = childExitState;
    forcedWindowsCloseTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settleWait(resolveObservedExitState(exitState));
    }, FORCED_WINDOWS_CLOSE_SETTLE_MS);
    forcedWindowsCloseTimer.unref?.();
  };

  const isWindowsHardKillSettlementBlocked = () =>
    process.platform === "win32" && hardKillRequested && !windowsTreeKillCompleted;

  const maybeSettleAfterWindowsExit = () => {
    if (
      process.platform !== "win32" ||
      isWindowsHardKillSettlementBlocked() ||
      childExitState == null ||
      !stdoutDrained ||
      !stderrDrained
    ) {
      return;
    }
    settleWait(resolveObservedExitState(childExitState));
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
    scheduleForcedWindowsCloseSettlement();
    maybeSettleAfterWindowsExit();
  });
  child.once("close", (code, signal) => {
    childCloseState = { code, signal };
    childExitState ??= childCloseState;
    if (isWindowsHardKillSettlementBlocked()) {
      return;
    }
    settleWait(resolveObservedExitState(childCloseState));
  });

  if (params.secretInput) {
    try {
      await writeSecretInputToChild(spawned.child, params.secretInput);
    } catch (error) {
      spawned.child.kill("SIGKILL");
      throw error;
    }
  }

  const wait = async () => {
    if (waitResult) {
      return waitResult;
    }
    if (waitError !== undefined) {
      throw toErrorObject(waitError, "Non-Error thrown");
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
            reject(toErrorObject(error, "Non-Error rejection"));
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
  const signalProcessTreeForChild = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    signalProcessTree(pid, signal, { detached: childIsDetached });
  };
  const signalProcessTreeForChildAndWait = (pid: number, signal: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      signalProcessTree(pid, signal, { detached: childIsDetached, onComplete: resolve });
    });
  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      hardKillRequested = true;
      scheduleForcedWindowsCloseSettlement();
      if (pid) {
        // Let the tree owner traverse the live root before directly killing it.
        // On Windows, killing the root first can make `taskkill /T` lose the
        // descendant relationship. (#71662)
        void signalProcessTreeForChildAndWait(pid, "SIGKILL").then(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore kill errors
          }
          windowsTreeKillCompleted = true;
          if (childCloseState) {
            settleWait(resolveObservedExitState(childCloseState));
            return;
          }
          maybeSettleAfterWindowsExit();
          scheduleForcedWindowsCloseSettlement();
        });
      } else {
        windowsTreeKillCompleted = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }
      scheduleForceKillWaitFallback("SIGKILL");
      return;
    }
    if (signal === "SIGTERM" && pid) {
      signalProcessTreeForChild(pid, "SIGTERM");
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
    clearForcedWindowsCloseTimer();
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
