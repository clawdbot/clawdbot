// Child process adapter wraps spawned child processes for the supervisor.
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { toErrorObject } from "../../../infra/errors.js";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../../../plugin-sdk/windows-spawn.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { onDecodedOutput } from "../../decoded-output.js";
import { signalProcessTree } from "../../kill-tree.js";
import { prepareOomScoreAdjustedSpawn } from "../../linux-oom-score.js";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "../../spawn-secret-input.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
  resolveWindowsCommandShim,
} from "../../windows-command.js";
import { createServiceChildRelayAdapter } from "../service-child-relay-host.js";
import type { SpawnProcessAdapter, SpawnSecretInput } from "../types.js";
import { createManagedChildStdin } from "./child-stdin.js";
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
type WorkerChildAdapter = ChildAdapter & {
  closeStartGate?: () => void;
  openStartGate?: () => Promise<void>;
};

const WORKER_START_MESSAGE = { type: "openclaw-worker-start-v1" } as const;

function isServiceManagedRuntime(): boolean {
  return Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
}

type ChildAdapterInput = {
  assertCurrent?: () => void;
  /** Own a separately signalable tree whose private IPC channel gates worker startup. */
  ownedWorker?: true;
  /** Preserve the supplied environment exactly by skipping environment-mutating spawn wrappers. */
  exactEnv?: true;
  onWorkerMessage?: (message: unknown) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv0?: string;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
  secretInput?: SpawnSecretInput;
  abortSignal?: AbortSignal;
} & (
  | { argv: string[]; anchoredShellCommand?: never }
  | { argv?: never; anchoredShellCommand: string }
);

export async function createChildAdapter(params: ChildAdapterInput): Promise<WorkerChildAdapter> {
  if (params.anchoredShellCommand !== undefined) {
    return await createServiceChildRelayAdapter({
      assertCurrent: params.assertCurrent,
      command: process.platform === "win32" ? params.anchoredShellCommand : "/bin/sh",
      args: process.platform === "win32" ? [] : ["-c", params.anchoredShellCommand],
      windowsShellCommand: process.platform === "win32" ? params.anchoredShellCommand : undefined,
      cwd: params.cwd,
      env: params.env,
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
      abortSignal: params.abortSignal,
    });
  }

  const baseEnv = params.env ? toStringEnv(params.env) : undefined;
  const invocation = resolveChildInvocation({
    argv: params.argv,
    env: baseEnv,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  });
  const argv0 = invocation.command === params.argv[0] ? params.argv0 : undefined;
  const preparedSpawn = params.exactEnv
    ? { command: invocation.command, args: invocation.args, argv0, env: baseEnv, wrapped: false }
    : prepareOomScoreAdjustedSpawn(invocation.command, invocation.args, { env: baseEnv, argv0 });

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  if (
    process.platform !== "win32" &&
    params.ownedWorker === undefined &&
    isServiceManagedRuntime()
  ) {
    return await createServiceChildRelayAdapter({
      assertCurrent: params.assertCurrent,
      command: preparedSpawn.command,
      args: preparedSpawn.args,
      argv0: preparedSpawn.argv0,
      cwd: params.cwd,
      env: preparedSpawn.env,
      stdinMode,
      input: params.input,
      secretInput: params.secretInput,
      oomScoreWrapperSelected: preparedSpawn.wrapped,
      abortSignal: params.abortSignal,
    });
  }

  // A detached POSIX child is still a descendant in the service cgroup/job, but
  // owns a process group that can be killed without touching the node host.
  const useDetached =
    process.platform !== "win32" &&
    (params.ownedWorker !== undefined || !isServiceManagedRuntime());

  const stdio: SpawnStdioEntry[] = [stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  using secretDelivery = prepareSecretInputStdio(stdio, params.secretInput);
  if (params.ownedWorker !== undefined) {
    stdio.push("ipc");
  }

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: preparedSpawn.env,
    argv0: preparedSpawn.argv0,
    stdio,
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };

  const spawned = await spawnWithFallback({
    assertCurrent: params.assertCurrent,
    argv: [preparedSpawn.command, ...preparedSpawn.args],
    options,
    fallbacks:
      useDetached && params.ownedWorker === undefined
        ? [
            {
              label: "no-detach",
              options: { detached: false },
            },
          ]
        : [],
  });

  const child = spawned.child as ChildProcessWithoutNullStreams;
  try {
    // Startup acknowledgement may outlive the caller; withhold all private input if it did.
    params.assertCurrent?.();
    if (params.ownedWorker !== undefined && (!child.connected || !child.channel)) {
      throw new Error("worker lifecycle IPC channel was not created");
    }
  } catch (error) {
    spawned.child.kill("SIGKILL");
    throw error;
  }
  if (params.onWorkerMessage) {
    child.on("message", (message) => {
      try {
        params.onWorkerMessage?.(message);
      } catch {
        // Worker diagnostics cannot change child supervision.
      }
    });
  }
  const disconnectWorkerIpc = () => {
    if (!child.connected) {
      return;
    }
    try {
      child.disconnect();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_IPC_DISCONNECTED") {
        throw error;
      }
    }
  };
  // Pipe errors can arrive before output subscribers attach. Close remains
  // responsible for decoder flush and Windows drain completion.
  const ignoreOutputStreamError = () => {};
  child.stdout.on("error", ignoreOutputStreamError);
  child.stderr.on("error", ignoreOutputStreamError);
  const childStdin = spawned.child.stdin;
  const stdin = createManagedChildStdin(childStdin);
  if (params.input !== undefined) {
    childStdin?.write(params.input);
    stdin?.end();
  } else if (stdinMode === "pipe-closed") {
    stdin?.end();
  }

  const outputUnsubscribers: Array<() => void> = [];
  const onStdout: ChildAdapter["onStdout"] = (listener, onRaw) => {
    outputUnsubscribers.push(onDecodedOutput(child.stdout, listener, onRaw));
  };

  const onStderr: ChildAdapter["onStderr"] = (listener, onRaw) => {
    outputUnsubscribers.push(onDecodedOutput(child.stderr, listener, onRaw));
  };

  const completion = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
  // Worker errors can precede wait(), including while secret delivery is still pending.
  void completion.promise.catch(() => {});
  let waitSettled = false;
  let forceKillWaitFallbackTimer: NodeJS.Timeout | null = null;
  let forcedWindowsCloseTimer: NodeJS.Timeout | null = null;
  let hardKillRequested = false;
  let windowsTreeKillCompleted = false;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let childCloseState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stdoutDrained = child.stdout == null;
  let stderrDrained = child.stderr == null;
  let workerIpcDisconnected = false;
  let openWorkerStdio = 0;

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
    if (waitSettled) {
      return;
    }
    waitSettled = true;
    clearForceKillWaitFallback();
    clearForcedWindowsCloseTimer();
    completion.resolve(value);
  };

  const rejectPendingWait = (error: Error) => {
    if (waitSettled) {
      return;
    }
    waitSettled = true;
    clearForceKillWaitFallback();
    clearForcedWindowsCloseTimer();
    completion.reject(error);
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

  const maybeSettleAfterExit = () => {
    if (
      (process.platform !== "win32" && (!workerIpcDisconnected || openWorkerStdio > 0)) ||
      isWindowsHardKillSettlementBlocked() ||
      childExitState == null ||
      !stdoutDrained ||
      !stderrDrained
    ) {
      return;
    }
    settleWait(resolveObservedExitState(childExitState));
  };

  if (params.ownedWorker) {
    // Parent-initiated IPC disconnect can suppress Node's child close event.
    // Preserve its exit-and-closed-pipes boundary, including secret descriptors.
    child.once("disconnect", () => {
      workerIpcDisconnected = true;
      maybeSettleAfterExit();
    });
    for (const stream of child.stdio.slice(1)) {
      if (!stream || stream.closed) {
        continue;
      }
      openWorkerStdio += 1;
      stream.once("close", () => {
        openWorkerStdio -= 1;
        maybeSettleAfterExit();
      });
    }
  }

  child.stdout?.once("end", () => {
    stdoutDrained = true;
    maybeSettleAfterExit();
  });
  child.stdout?.once("close", () => {
    stdoutDrained = true;
    maybeSettleAfterExit();
  });
  child.stderr?.once("end", () => {
    stderrDrained = true;
    maybeSettleAfterExit();
  });
  child.stderr?.once("close", () => {
    stderrDrained = true;
    maybeSettleAfterExit();
  });

  // Worker IPC failures close authority; ordinary post-spawn errors are nonterminal.
  child.on("error", params.ownedWorker ? rejectPendingWait : () => {});
  child.once("exit", (code, signal) => {
    childExitState = { code, signal };
    scheduleForcedWindowsCloseSettlement();
    maybeSettleAfterExit();
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
      params.assertCurrent?.();
      await secretDelivery?.deliverTo(spawned.child, { abortSignal: params.abortSignal });
    } catch (error) {
      spawned.child.kill("SIGKILL");
      throw error;
    }
  }

  const wait = async () => await completion.promise;

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
          maybeSettleAfterExit();
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
    if (params.ownedWorker !== undefined) {
      disconnectWorkerIpc();
    }
    for (const unsubscribe of outputUnsubscribers.splice(0)) {
      unsubscribe();
    }
    // Error handling and Node's child-close bookkeeping must remain attached during destroy.
    child.stdout.destroy();
    child.stderr.destroy();
    child.removeAllListeners();
  };

  const closeStartGate = params.ownedWorker ? disconnectWorkerIpc : undefined;

  let startGateOpened = false;
  const openStartGate = params.ownedWorker
    ? async () => {
        if (startGateOpened) {
          return;
        }
        startGateOpened = true;
        await new Promise<void>((resolve, reject) => {
          if (!child.connected) {
            reject(new Error("worker lifecycle IPC channel closed before startup"));
            return;
          }
          try {
            child.send(WORKER_START_MESSAGE, (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          } catch (error) {
            reject(toErrorObject(error, "worker lifecycle IPC send failed"));
          }
        });
      }
    : undefined;

  return {
    pid: child.pid ?? undefined,
    stdin,
    oomScoreWrapperSelected: preparedSpawn.wrapped,
    supportsRawOutput: true,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
    closeStartGate,
    openStartGate,
  };
}
